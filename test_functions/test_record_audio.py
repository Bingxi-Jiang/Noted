import queue
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import soundcard as sc
import soundfile as sf


def ensure_output_dir() -> Path:
    out_dir = Path("outputs") / "audio"
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def normalize_audio(audio: np.ndarray, peak: float = 0.98) -> np.ndarray:
    if audio.size == 0:
        return audio
    max_val = np.max(np.abs(audio))
    if max_val < 1e-9:
        return audio
    if max_val > peak:
        audio = audio * (peak / max_val)
    return audio


def align_channels(audio: np.ndarray, channels: int) -> np.ndarray:
    if audio.ndim == 1:
        audio = audio[:, None]

    current_channels = audio.shape[1]
    if current_channels == channels:
        return audio
    if current_channels > channels:
        return audio[:, :channels]

    extra = np.repeat(audio[:, -1:], channels - current_channels, axis=1)
    return np.concatenate([audio, extra], axis=1)


def mix_audio(system_audio: np.ndarray, mic_audio: np.ndarray) -> np.ndarray:
    max_len = max(len(system_audio), len(mic_audio))
    max_channels = max(
        system_audio.shape[1] if system_audio.ndim > 1 else 1,
        mic_audio.shape[1] if mic_audio.ndim > 1 else 1,
    )

    def pad_audio(audio: np.ndarray, target_len: int, target_channels: int) -> np.ndarray:
        audio = align_channels(audio, target_channels)
        if len(audio) < target_len:
            pad = np.zeros((target_len - len(audio), target_channels), dtype=audio.dtype)
            audio = np.vstack([audio, pad])
        return audio

    system_audio = pad_audio(system_audio, max_len, max_channels)
    mic_audio = pad_audio(mic_audio, max_len, max_channels)

    mixed = 0.5 * system_audio + 0.5 * mic_audio
    return normalize_audio(mixed).astype(np.float32)


def find_loopback_microphone_for_default_speaker():
    default_speaker = sc.default_speaker()
    if default_speaker is None:
        raise RuntimeError("No default speaker device found.")

    loopbacks = sc.all_microphones(include_loopback=True)

    for mic in loopbacks:
        try:
            if getattr(mic, "isloopback", False) and mic.name == default_speaker.name:
                return mic, default_speaker
        except Exception:
            pass

    for mic in loopbacks:
        try:
            if getattr(mic, "isloopback", False):
                if (
                    default_speaker.name.lower() in mic.name.lower()
                    or mic.name.lower() in default_speaker.name.lower()
                ):
                    return mic, default_speaker
        except Exception:
            pass

    raise RuntimeError(
        f"Could not find loopback microphone for default speaker: {default_speaker.name}"
    )


def record_device(
    device_name: str,
    microphone,
    sample_rate: int,
    channels: int,
    stop_event: threading.Event,
    out_queue: queue.Queue,
    blocksize: int = 1024,
) -> None:
    chunks = []
    try:
        with microphone.recorder(
            samplerate=sample_rate,
            channels=channels,
            blocksize=blocksize,
        ) as rec:
            print(f"[INFO] {device_name} recording started.")
            while not stop_event.is_set():
                data = rec.record(numframes=blocksize)
                if data is not None and len(data) > 0:
                    chunks.append(np.asarray(data, dtype=np.float32))
    except Exception as e:
        out_queue.put((device_name, e))
        return

    if chunks:
        audio = np.concatenate(chunks, axis=0)
    else:
        audio = np.zeros((0, channels), dtype=np.float32)

    out_queue.put((device_name, audio))


def wait_for_stop_command(stop_event: threading.Event) -> None:
    print("[INFO] 输入 stop 然后按回车即可停止录音。")
    while not stop_event.is_set():
        try:
            command = input("> ").strip().lower()
        except EOFError:
            command = "stop"
        except KeyboardInterrupt:
            command = "stop"

        if command == "stop":
            stop_event.set()
            break
        elif command:
            print('[INFO] 未识别命令。请输入 "stop" 停止录音。')


def main():
    SAMPLE_RATE = 48000
    SYSTEM_CHANNELS = 2
    MIC_CHANNELS = 1

    out_dir = ensure_output_dir()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    system_path = out_dir / f"{timestamp}_system.wav"
    mic_path = out_dir / f"{timestamp}_mic.wav"
    mixed_path = out_dir / f"{timestamp}_overall.wav"

    try:
        default_mic = sc.default_microphone()
        loopback_mic, default_speaker = find_loopback_microphone_for_default_speaker()
    except Exception as e:
        print(f"[ERROR] Failed to initialize audio devices: {e}")
        sys.exit(1)

    if default_mic is None:
        print("[ERROR] No default microphone found.")
        sys.exit(1)

    print("[INFO] Using devices:")
    print(f"       Default microphone : {default_mic.name}")
    print(f"       Default speaker    : {default_speaker.name}")
    print(f"       Loopback device    : {loopback_mic.name}")

    stop_event = threading.Event()
    result_queue = queue.Queue()

    system_thread = threading.Thread(
        target=record_device,
        args=(
            "system",
            loopback_mic,
            SAMPLE_RATE,
            SYSTEM_CHANNELS,
            stop_event,
            result_queue,
        ),
        daemon=True,
    )

    mic_thread = threading.Thread(
        target=record_device,
        args=(
            "mic",
            default_mic,
            SAMPLE_RATE,
            MIC_CHANNELS,
            stop_event,
            result_queue,
        ),
        daemon=True,
    )

    input_thread = threading.Thread(
        target=wait_for_stop_command,
        args=(stop_event,),
        daemon=True,
    )

    print("[INFO] Recording started.")
    system_thread.start()
    mic_thread.start()
    input_thread.start()

    try:
        while not stop_event.is_set():
            time.sleep(0.2)
    except KeyboardInterrupt:
        stop_event.set()

    system_thread.join()
    mic_thread.join()
    print("[INFO] Recording stopped.")

    results = {}
    for _ in range(2):
        name, payload = result_queue.get()
        if isinstance(payload, Exception):
            print(f"[ERROR] {name} recording failed: {payload}")
            sys.exit(1)
        results[name] = payload

    system_audio = results["system"]
    mic_audio = results["mic"]

    if system_audio.ndim == 1:
        system_audio = system_audio[:, None]
    if mic_audio.ndim == 1:
        mic_audio = mic_audio[:, None]

    system_audio = normalize_audio(system_audio).astype(np.float32)
    mic_audio = normalize_audio(mic_audio).astype(np.float32)
    mixed_audio = mix_audio(system_audio, mic_audio)

    sf.write(system_path, system_audio, SAMPLE_RATE)
    sf.write(mic_path, mic_audio, SAMPLE_RATE)
    sf.write(mixed_path, mixed_audio, SAMPLE_RATE)

    print("[INFO] Saved files:")
    print(f"       System audio : {system_path}")
    print(f"       Microphone   : {mic_path}")
    print(f"       Overall mix  : {mixed_path}")


if __name__ == "__main__":
    main()