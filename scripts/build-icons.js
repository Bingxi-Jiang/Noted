import fs from 'node:fs/promises';

// Vendor only the Phosphor regular-weight icons used by the vanilla client.
const names = [
  'arrow-left', 'arrow-right', 'arrows-clockwise', 'book-open', 'chat-circle',
  'check', 'checks', 'cloud-arrow-up', 'download-simple', 'file-doc', 'file-text',
  'folder', 'folders', 'gear-six', 'graduation-cap', 'info', 'lightbulb',
  'microphone', 'microphone-slash', 'monitor', 'moon', 'note-pencil', 'play',
  'plus', 'sidebar-simple', 'sparkle', 'square', 'sun', 'trash', 'users', 'x',
  'magnifying-glass',
];
const symbols = await Promise.all(names.map(async name => {
  const svg = await fs.readFile(new URL(`../node_modules/@phosphor-icons/core/assets/regular/${name}.svg`, import.meta.url), 'utf8');
  const body = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return `<symbol id="${name}" viewBox="0 0 256 256">${body}</symbol>`;
}));
await fs.mkdir(new URL('../public/icons/', import.meta.url), { recursive: true });
await fs.writeFile(new URL('../public/icons/phosphor.svg', import.meta.url), `<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor">${symbols.join('')}</svg>\n`);
await fs.copyFile(new URL('../node_modules/@phosphor-icons/core/LICENSE', import.meta.url), new URL('../public/icons/LICENSE', import.meta.url));
console.log(`Built ${names.length} local Phosphor icons.`);
