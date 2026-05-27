import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const sourcePath = path.join(process.cwd(), 'extension', 'v1.py');
const outputTargets = [
  path.join(process.cwd(), 'public', 'downloads', 'rendersphere-blender-addon.zip'),
  path.join(process.cwd(), 'frontend', 'public', 'downloads', 'rendersphere-blender-addon.zip'),
];

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let j = 0; j < 8; j += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[i] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

function uint16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosDate, dosTime } = dosDateTime(new Date());

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll('\\', '/'));
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const checksum = crc32(data);

    const localHeader = Buffer.concat([
      uint32(0x04034b50),
      uint16(20),
      uint16(0),
      uint16(0),
      uint16(dosTime),
      uint16(dosDate),
      uint32(checksum),
      uint32(data.length),
      uint32(data.length),
      uint16(name.length),
      uint16(0),
      name,
    ]);

    localParts.push(localHeader, data);

    centralParts.push(Buffer.concat([
      uint32(0x02014b50),
      uint16(20),
      uint16(20),
      uint16(0),
      uint16(0),
      uint16(dosTime),
      uint16(dosDate),
      uint32(checksum),
      uint32(data.length),
      uint32(data.length),
      uint16(name.length),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(0),
      uint32(offset),
      name,
    ]));

    offset += localHeader.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.concat([
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(entries.length),
    uint16(entries.length),
    uint32(centralDirectory.length),
    uint32(offset),
    uint16(0),
  ]);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

let addonSourceText = await readFile(sourcePath, 'utf8');
const publicUrl = process.env.RENDERSPHERE_PUBLIC_URL?.replace(/\/+$/, '');
if (publicUrl) {
  addonSourceText = addonSourceText.replace(
    /DEFAULT_SERVER_URL = ".*?"/,
    `DEFAULT_SERVER_URL = ${JSON.stringify(publicUrl)}`
  );
}

const addonSource = Buffer.from(addonSourceText);
const readme = Buffer.from(
  [
    'RenderSphere Blender Add-on',
    '',
    'Install this zip from Blender: Edit > Preferences > Add-ons > Install.',
    'After enabling it, paste your RenderSphere access key into the add-on preferences.',
    publicUrl ? `Default gateway URL in this package: ${publicUrl}` : 'Default gateway URL in this package: http://localhost:3000',
    '',
  ].join('\n')
);

const archive = createZip([
  { name: 'rendersphere.py', data: addonSource },
  { name: 'README.txt', data: readme },
]);

for (const outputPath of outputTargets) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, archive);
  console.log(`Packaged ${outputPath}`);
}
