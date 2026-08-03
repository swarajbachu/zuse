import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";

export interface ZipEntry {
	readonly name: string;
	readonly data: Buffer;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit += 1) {
		value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	}
	return value >>> 0;
});

function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data)
		crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
	return (crc ^ 0xffffffff) >>> 0;
}

async function fileCrc32(path: string): Promise<number> {
	let crc = 0xffffffff;
	for await (const chunk of createReadStream(path, {
		highWaterMark: 64 * 1024,
	})) {
		for (const byte of chunk as Buffer)
			crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipFileEntry {
	readonly name: string;
	readonly path: string;
}

export async function writeStoredZip(
	path: string,
	entries: ReadonlyArray<ZipFileEntry>,
	options?: { readonly onArtifactChunk?: (bytes: number) => void },
): Promise<void> {
	const output = await open(path, "w");
	const centralParts: Buffer[] = [];
	let offset = 0;
	try {
		for (const entry of entries) {
			const [file, checksum] = await Promise.all([
				stat(entry.path),
				fileCrc32(entry.path),
			]);
			const name = Buffer.from(entry.name.replaceAll("\\", "/"), "utf8");
			const localHeader = Buffer.alloc(30);
			localHeader.writeUInt32LE(0x04034b50, 0);
			localHeader.writeUInt16LE(20, 4);
			localHeader.writeUInt32LE(checksum, 14);
			localHeader.writeUInt32LE(file.size, 18);
			localHeader.writeUInt32LE(file.size, 22);
			localHeader.writeUInt16LE(name.length, 26);
			await output.write(localHeader);
			await output.write(name);
			for await (const chunk of createReadStream(entry.path, {
				highWaterMark: 64 * 1024,
			})) {
				options?.onArtifactChunk?.((chunk as Buffer).length);
				await output.write(chunk as Buffer);
			}

			const centralHeader = Buffer.alloc(46);
			centralHeader.writeUInt32LE(0x02014b50, 0);
			centralHeader.writeUInt16LE(20, 4);
			centralHeader.writeUInt16LE(20, 6);
			centralHeader.writeUInt32LE(checksum, 16);
			centralHeader.writeUInt32LE(file.size, 20);
			centralHeader.writeUInt32LE(file.size, 24);
			centralHeader.writeUInt16LE(name.length, 28);
			centralHeader.writeUInt32LE(offset, 42);
			centralParts.push(centralHeader, name);
			offset += localHeader.length + name.length + file.size;
		}
		const centralDirectory = Buffer.concat(centralParts);
		await output.write(centralDirectory);
		const end = Buffer.alloc(22);
		end.writeUInt32LE(0x06054b50, 0);
		end.writeUInt16LE(entries.length, 8);
		end.writeUInt16LE(entries.length, 10);
		end.writeUInt32LE(centralDirectory.length, 12);
		end.writeUInt32LE(offset, 16);
		await output.write(end);
	} finally {
		await output.close();
	}
}

export function createStoredZip(entries: ReadonlyArray<ZipEntry>): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const name = Buffer.from(entry.name.replaceAll("\\", "/"), "utf8");
		const checksum = crc32(entry.data);
		const localHeader = Buffer.alloc(30);
		localHeader.writeUInt32LE(0x04034b50, 0);
		localHeader.writeUInt16LE(20, 4);
		localHeader.writeUInt32LE(checksum, 14);
		localHeader.writeUInt32LE(entry.data.length, 18);
		localHeader.writeUInt32LE(entry.data.length, 22);
		localHeader.writeUInt16LE(name.length, 26);
		localParts.push(localHeader, name, entry.data);

		const centralHeader = Buffer.alloc(46);
		centralHeader.writeUInt32LE(0x02014b50, 0);
		centralHeader.writeUInt16LE(20, 4);
		centralHeader.writeUInt16LE(20, 6);
		centralHeader.writeUInt32LE(checksum, 16);
		centralHeader.writeUInt32LE(entry.data.length, 20);
		centralHeader.writeUInt32LE(entry.data.length, 24);
		centralHeader.writeUInt16LE(name.length, 28);
		centralHeader.writeUInt32LE(offset, 42);
		centralParts.push(centralHeader, name);
		offset += localHeader.length + name.length + entry.data.length;
	}

	const centralDirectory = Buffer.concat(centralParts);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...localParts, centralDirectory, end]);
}
