import ghosttyModuleUrl from "./vendor/ghostty-vt.wasm?url";
import callbackModuleUrl from "./vendor/pty-callback.wasm?url&no-inline";

type CallableExport = (...arguments_: Array<number | bigint>) => number;

type AbiField = Readonly<{
	offset: number;
	size: number;
	type: string;
}>;

type AbiLayout = Readonly<{
	size: number;
	align: number;
	fields: Readonly<Record<string, AbiField>>;
}>;

type AbiLayouts = Readonly<Record<string, AbiLayout>>;

const decoder = new TextDecoder();

export class GhosttyWasmRuntime {
	readonly memory: WebAssembly.Memory;
	readonly layouts: AbiLayouts;

	private readonly moduleExports: WebAssembly.Exports;
	private readonly replyHandlers = new Map<
		number,
		(data: Uint8Array) => void
	>();
	private nextReplyHandler = 1;
	private callbackTableIndex: number | null = null;

	private constructor(instance: WebAssembly.Instance) {
		this.moduleExports = instance.exports;
		const memory = instance.exports.memory;
		if (!(memory instanceof WebAssembly.Memory)) {
			throw new Error("Ghostty did not export WebAssembly memory");
		}
		this.memory = memory;
		const start = this.invoke("ghostty_type_json");
		const bytes = new Uint8Array(memory.buffer);
		let end = start;
		while (end < bytes.byteLength && bytes[end] !== 0) end += 1;
		this.layouts = JSON.parse(
			decoder.decode(bytes.subarray(start, end)),
		) as AbiLayouts;
	}

	static async load(): Promise<GhosttyWasmRuntime> {
		const response = await fetch(ghosttyModuleUrl);
		if (!response.ok) {
			throw new Error(`Unable to load Ghostty (${response.status})`);
		}
		let memory: WebAssembly.Memory | null = null;
		const result = await WebAssembly.instantiate(await response.arrayBuffer(), {
			env: {
				log: (pointer: number, length: number) => {
					if (memory === null) return;
					const message = decoder.decode(
						new Uint8Array(memory.buffer, pointer, length),
					);
					console.debug("[ghostty]", message);
				},
			},
		});
		const runtime = new GhosttyWasmRuntime(result.instance);
		memory = runtime.memory;
		await runtime.installReplyCallback();
		return runtime;
	}

	invoke(name: string, ...arguments_: Array<number | bigint>): number {
		const value = this.moduleExports[name];
		if (typeof value !== "function") {
			throw new Error(`Missing Ghostty export: ${name}`);
		}
		return (value as CallableExport)(...arguments_);
	}

	layout(name: string): AbiLayout {
		const value = this.layouts[name];
		if (value === undefined)
			throw new Error(`Missing Ghostty ABI layout: ${name}`);
		return value;
	}

	allocate(size: number): number {
		const pointer = this.invoke("ghostty_wasm_alloc_u8_array", size);
		if (pointer === 0)
			throw new Error(`Ghostty could not allocate ${size} bytes`);
		this.bytes(pointer, size).fill(0);
		return pointer;
	}

	release(pointer: number, size: number): void {
		if (pointer !== 0) this.invoke("ghostty_wasm_free_u8_array", pointer, size);
	}

	allocateHandleSlot(): number {
		const pointer = this.invoke("ghostty_wasm_alloc_opaque");
		if (pointer === 0)
			throw new Error("Ghostty could not allocate a handle slot");
		this.view(pointer, 4).setUint32(0, 0, true);
		return pointer;
	}

	releaseHandleSlot(pointer: number): void {
		if (pointer !== 0) this.invoke("ghostty_wasm_free_opaque", pointer);
	}

	readHandle(pointer: number): number {
		return this.view(pointer, 4).getUint32(0, true);
	}

	view(pointer: number, size?: number): DataView {
		return new DataView(this.memory.buffer, pointer, size);
	}

	bytes(pointer: number, size: number): Uint8Array {
		return new Uint8Array(this.memory.buffer, pointer, size);
	}

	writeField(
		pointer: number,
		layoutName: string,
		fieldName: string,
		value: number,
	): void {
		const field = this.layout(layoutName).fields[fieldName];
		if (field === undefined) {
			throw new Error(`Missing Ghostty ABI field: ${layoutName}.${fieldName}`);
		}
		const view = this.view(pointer + field.offset, field.size);
		switch (field.type) {
			case "bool":
			case "u8":
				view.setUint8(0, value);
				break;
			case "u16":
				view.setUint16(0, value, true);
				break;
			case "i32":
				view.setInt32(0, value, true);
				break;
			case "u32":
			case "enum":
				view.setUint32(0, value, true);
				break;
			case "f32":
				view.setFloat32(0, value, true);
				break;
			case "f64":
				view.setFloat64(0, value, true);
				break;
			case "u64":
				view.setBigUint64(0, BigInt(value), true);
				break;
			default:
				throw new Error(`Unsupported Ghostty field type: ${field.type}`);
		}
	}

	readField(pointer: number, layoutName: string, fieldName: string): number {
		const field = this.layout(layoutName).fields[fieldName];
		if (field === undefined) {
			throw new Error(`Missing Ghostty ABI field: ${layoutName}.${fieldName}`);
		}
		const view = this.view(pointer + field.offset, field.size);
		switch (field.type) {
			case "bool":
			case "u8":
				return view.getUint8(0);
			case "u16":
				return view.getUint16(0, true);
			case "i32":
				return view.getInt32(0, true);
			case "u32":
			case "enum":
				return view.getUint32(0, true);
			case "f32":
				return view.getFloat32(0, true);
			case "f64":
				return view.getFloat64(0, true);
			case "u64":
				return Number(view.getBigUint64(0, true));
			default:
				throw new Error(`Unsupported Ghostty field type: ${field.type}`);
		}
	}

	registerTerminalReplies(
		terminal: number,
		handler: (data: Uint8Array) => void,
	): () => void {
		if (this.callbackTableIndex === null) {
			throw new Error("Ghostty reply callback was not installed");
		}
		const identifier = this.nextReplyHandler++;
		this.replyHandlers.set(identifier, handler);
		this.invoke("ghostty_terminal_set", terminal, 0, identifier);
		this.invoke("ghostty_terminal_set", terminal, 1, this.callbackTableIndex);
		return () => {
			this.invoke("ghostty_terminal_set", terminal, 1, 0);
			this.invoke("ghostty_terminal_set", terminal, 0, 0);
			this.replyHandlers.delete(identifier);
		};
	}

	private async installReplyCallback(): Promise<void> {
		const response = await fetch(callbackModuleUrl);
		if (!response.ok) {
			throw new Error(`Unable to load Ghostty callback (${response.status})`);
		}
		const result = await WebAssembly.instantiate(await response.arrayBuffer(), {
			env: {
				zuse_terminal_reply: (
					_terminal: number,
					identifier: number,
					pointer: number,
					length: number,
				) => {
					const handler = this.replyHandlers.get(identifier);
					if (handler === undefined || length === 0) return;
					handler(this.bytes(pointer, length).slice());
				},
			},
		});
		const callback = result.instance.exports.zuse_ghostty_terminal_reply;
		const table = this.moduleExports.__indirect_function_table;
		if (
			typeof callback !== "function" ||
			!(table instanceof WebAssembly.Table)
		) {
			throw new Error("Ghostty callback table is unavailable");
		}
		const index = table.length;
		table.grow(1);
		table.set(index, callback);
		this.callbackTableIndex = index;
	}
}

let sharedRuntime: Promise<GhosttyWasmRuntime> | null = null;

export function loadGhosttyWasm(): Promise<GhosttyWasmRuntime> {
	sharedRuntime ??= GhosttyWasmRuntime.load().catch((cause) => {
		sharedRuntime = null;
		throw cause;
	});
	return sharedRuntime;
}
