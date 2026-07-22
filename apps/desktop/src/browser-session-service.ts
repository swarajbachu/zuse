import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { Session } from "electron";
import keytar from "keytar";

const execFileAsync = promisify(execFile);
const PARTITION = "persist:zuse-browser";
const COOKIE_EPOCH_OFFSET_SECONDS = 11_644_473_600;

type ImportedCookieIdentity = {
	domain: string;
	path: string;
	name: string;
	secure?: boolean;
	valueHash?: string;
};

type ImportState = {
	version: 1;
	migratedExistingSession: boolean;
	selectedProfileId?: string;
	lastImportTime?: string;
	source?: string;
	profile?: string;
	identities: ImportedCookieIdentity[];
};

export interface BrowserCookieImportProfile {
	readonly id: string;
	readonly source: string;
	readonly profile: string;
	readonly isDefault: boolean;
}

export interface BrowserCookieImportStatus {
	readonly supported: boolean;
	readonly selectedProfileId?: string;
	readonly availableProfiles: ReadonlyArray<BrowserCookieImportProfile>;
	readonly source?: string;
	readonly profile?: string;
	readonly lastImportTime?: string;
	readonly importedDomainCount: number;
	readonly importedCookieCount: number;
	readonly importedDomains: ReadonlyArray<string>;
	readonly message?: string;
}

const statePath = (userData: string) =>
	Path.join(userData, "browser-cookie-import.json");

const readState = async (userData: string): Promise<ImportState> => {
	try {
		const parsed = JSON.parse(
			await fs.readFile(statePath(userData), "utf8"),
		) as Partial<ImportState>;
		return {
			version: 1,
			migratedExistingSession: parsed.migratedExistingSession === true,
			...(typeof parsed.selectedProfileId === "string"
				? { selectedProfileId: parsed.selectedProfileId }
				: {}),
			...(typeof parsed.lastImportTime === "string"
				? { lastImportTime: parsed.lastImportTime }
				: {}),
			...(typeof parsed.source === "string" ? { source: parsed.source } : {}),
			...(typeof parsed.profile === "string"
				? { profile: parsed.profile }
				: {}),
			identities: Array.isArray(parsed.identities)
				? parsed.identities.filter(isIdentity)
				: [],
		};
	} catch {
		return { version: 1, migratedExistingSession: false, identities: [] };
	}
};

const isIdentity = (value: unknown): value is ImportedCookieIdentity => {
	if (value === null || typeof value !== "object") return false;
	const item = value as Partial<ImportedCookieIdentity>;
	return (
		typeof item.domain === "string" &&
		typeof item.path === "string" &&
		typeof item.name === "string" &&
		(item.secure === undefined || typeof item.secure === "boolean") &&
		(item.valueHash === undefined || typeof item.valueHash === "string")
	);
};

const writeState = async (
	userData: string,
	state: ImportState,
): Promise<void> => {
	await fs.writeFile(statePath(userData), JSON.stringify(state, null, 2), {
		mode: 0o600,
	});
};

export const migrateExistingBrowserCookies = async (
	userData: string,
	legacy: Session,
	persistent: Session,
): Promise<void> => {
	const state = await readState(userData);
	if (state.migratedExistingSession) return;
	for (const cookie of await legacy.cookies.get({})) {
		if (cookie.domain === undefined) continue;
		try {
			await persistent.cookies.set({
				url: `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path}`,
				name: cookie.name,
				value: cookie.value,
				domain: cookie.domain,
				path: cookie.path,
				secure: cookie.secure,
				httpOnly: cookie.httpOnly,
				...(cookie.expirationDate === undefined
					? {}
					: { expirationDate: cookie.expirationDate }),
				...(cookie.sameSite === "unspecified"
					? {}
					: { sameSite: cookie.sameSite }),
			});
		} catch {
			// Individual invalid or internal cookies must not abort first-use migration.
		}
	}
	await writeState(userData, { ...state, migratedExistingSession: true });
};

const parseDefaultHandlerBundle = (stdout: string): string | null => {
	let depth = 0;
	let role: string | null = null;
	let scheme: string | null = null;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (depth === 1) {
			const roleMatch = trimmed.match(
				/^LSHandlerRoleAll\s*=\s*"?([^";\s]+)"?;$/i,
			);
			if (roleMatch?.[1]) role = roleMatch[1];
			const schemeMatch = trimmed.match(
				/^LSHandlerURLScheme\s*=\s*"?([^";\s]+)"?;$/i,
			);
			if (schemeMatch?.[1]) scheme = schemeMatch[1];
		}
		depth += (trimmed.match(/\{/g) ?? []).length;
		depth -= (trimmed.match(/\}/g) ?? []).length;
		if (depth === 0) {
			if (scheme?.toLowerCase() === "https" && role !== null && role !== "-")
				return role;
			role = null;
			scheme = null;
		}
	}
	return null;
};

const defaultHandlerBundle = async (): Promise<string | null> => {
	if (process.platform !== "darwin") return null;
	try {
		const { stdout } = await execFileAsync("defaults", [
			"read",
			"com.apple.LaunchServices/com.apple.launchservices.secure",
			"LSHandlers",
		]);
		return parseDefaultHandlerBundle(stdout);
	} catch {
		return null;
	}
};

const findApplication = async (bundleId: string): Promise<string | null> => {
	try {
		const { stdout } = await execFileAsync("mdfind", [
			`kMDItemCFBundleIdentifier == '${bundleId}'`,
		]);
		return stdout.split("\n").find((line) => line.endsWith(".app")) ?? null;
	} catch {
		return null;
	}
};

const normalized = (value: string) =>
	value.toLowerCase().replace(/[^a-z0-9]/g, "");

const findProfileRoots = async (): Promise<ReadonlyArray<string>> => {
	const support = Path.join(homedir(), "Library", "Application Support");
	const found: string[] = [];
	const walk = async (directory: string, depth: number): Promise<void> => {
		if (depth > 2) return;
		let entries: Array<{
			name: string;
			isFile(): boolean;
			isDirectory(): boolean;
		}>;
		try {
			entries = await fs.readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		if (
			entries.some((entry) => entry.isFile() && entry.name === "Local State")
		) {
			found.push(directory);
			return;
		}
		await Promise.all(
			entries
				.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
				.map((entry) => walk(Path.join(directory, entry.name), depth + 1)),
		);
	};
	await walk(support, 0);
	return found.sort();
};

const findProfileRoot = async (sourceName: string): Promise<string | null> => {
	const wanted = normalized(sourceName);
	if (wanted.length === 0) return null;
	const scored = (await findProfileRoots()).map((path) => {
		const base = normalized(Path.basename(path));
		return {
			path,
			score: wanted.includes(base) || base.includes(wanted) ? 10 : 1,
		};
	});
	const best = scored.sort((a, b) => b.score - a.score)[0];
	return best?.score === 10 ? best.path : null;
};

type DetectedProfile = {
	id: string;
	source: string;
	profile: string;
	profileDirectory: string;
	root: string;
	cookieDb: string;
};

const sourceNameForRoot = (root: string): string => {
	const rootName = Path.basename(root);
	return (
		rootName === "User Data" ? Path.basename(Path.dirname(root)) : rootName
	)
		.replaceAll("-", " ")
		.trim();
};

const installedBrowserSources = async (
	sources: ReadonlySet<string>,
): Promise<ReadonlySet<string>> => {
	const applications: Array<{ name: string; path: string }> = [];
	for (const directory of [
		"/Applications",
		Path.join(homedir(), "Applications"),
	]) {
		try {
			for (const entry of await fs.readdir(directory, {
				withFileTypes: true,
			})) {
				if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;
				const name = Path.basename(entry.name, ".app");
				const normalizedName = normalized(name);
				if (
					![...sources].some((source) => {
						const normalizedSource = normalized(source);
						return (
							normalizedName.includes(normalizedSource) ||
							normalizedSource.includes(normalizedName)
						);
					})
				)
					continue;
				applications.push({ name, path: Path.join(directory, entry.name) });
			}
		} catch {
			// An optional application directory may not exist or be readable.
		}
	}
	const browserNames = new Set<string>();
	await Promise.all(
		applications.map(async (application) => {
			try {
				const { stdout } = await execFileAsync("plutil", [
					"-extract",
					"CFBundleURLTypes",
					"json",
					"-o",
					"-",
					Path.join(application.path, "Contents", "Info.plist"),
				]);
				const urlTypes = JSON.parse(stdout) as Array<{
					CFBundleURLSchemes?: unknown;
				}>;
				const handlesWebUrls = urlTypes.some(
					(type) =>
						Array.isArray(type.CFBundleURLSchemes) &&
						type.CFBundleURLSchemes.some(
							(scheme) => scheme === "http" || scheme === "https",
						),
				);
				if (handlesWebUrls) browserNames.add(normalized(application.name));
			} catch {
				// Applications without declared web URL schemes are not browsers.
			}
		}),
	);
	return new Set(
		[...sources].filter((source) => {
			const normalizedSource = normalized(source);
			return [...browserNames].some(
				(name) =>
					name.includes(normalizedSource) || normalizedSource.includes(name),
			);
		}),
	);
};

const profileId = (root: string, profile: string): string =>
	createHash("sha256").update(`${root}\0${profile}`).digest("hex").slice(0, 20);

const findCookieDb = async (
	root: string,
	profile: string,
): Promise<string | null> => {
	for (const candidate of [
		Path.join(root, profile, "Network", "Cookies"),
		Path.join(root, profile, "Cookies"),
	]) {
		try {
			await fs.access(candidate);
			return candidate;
		} catch {
			// Try the next Chromium cookie database layout.
		}
	}
	return null;
};

const profilesForRoot = async (
	root: string,
	source = sourceNameForRoot(root),
): Promise<DetectedProfile[]> => {
	let localState: {
		profile?: {
			last_used?: unknown;
			info_cache?: Record<string, unknown>;
		};
	};
	try {
		localState = JSON.parse(
			await fs.readFile(Path.join(root, "Local State"), "utf8"),
		) as typeof localState;
	} catch {
		return [];
	}
	const lastUsed =
		typeof localState.profile?.last_used === "string"
			? localState.profile.last_used
			: "Default";
	const names = [
		lastUsed,
		...Object.keys(localState.profile?.info_cache ?? {}).filter(
			(name) => name !== lastUsed,
		),
	];
	const profiles: DetectedProfile[] = [];
	for (const profileDirectory of names) {
		const cookieDb = await findCookieDb(root, profileDirectory);
		if (cookieDb === null) continue;
		const metadata = localState.profile?.info_cache?.[profileDirectory] as
			| { name?: unknown }
			| undefined;
		const profile =
			typeof metadata?.name === "string" && metadata.name.trim().length > 0
				? metadata.name.trim()
				: profileDirectory;
		profiles.push({
			id: profileId(root, profileDirectory),
			source,
			profile,
			profileDirectory,
			root,
			cookieDb,
		});
	}
	return profiles;
};

const detectDefaultProfile = async (): Promise<DetectedProfile | null> => {
	const bundleId = await defaultHandlerBundle();
	if (bundleId === null) return null;
	const application = await findApplication(bundleId);
	const sourceHint =
		application === null ? bundleId : Path.basename(application, ".app");
	const root = await findProfileRoot(sourceHint);
	if (root === null) return null;
	const source = application === null ? sourceNameForRoot(root) : sourceHint;
	return (await profilesForRoot(root, source))[0] ?? null;
};

const detectProfiles = async (): Promise<{
	defaultProfile: DetectedProfile | null;
	profiles: DetectedProfile[];
}> => {
	const [defaultProfile, roots] = await Promise.all([
		detectDefaultProfile(),
		findProfileRoots(),
	]);
	const allDiscovered = (
		await Promise.all(roots.map((root) => profilesForRoot(root)))
	)
		.flat()
		.filter((profile) => profile.source.length > 0);
	const installedSources = await installedBrowserSources(
		new Set(allDiscovered.map((profile) => profile.source)),
	);
	const discovered = allDiscovered.filter((profile) =>
		installedSources.has(profile.source),
	);
	const byId = new Map(discovered.map((profile) => [profile.id, profile]));
	if (defaultProfile !== null) byId.set(defaultProfile.id, defaultProfile);
	const profiles = [...byId.values()].sort((a, b) => {
		if (a.id === defaultProfile?.id) return -1;
		if (b.id === defaultProfile?.id) return 1;
		return `${a.source}\0${a.profile}`.localeCompare(
			`${b.source}\0${b.profile}`,
		);
	});
	return { defaultProfile, profiles };
};

const decryptCookie = (
	encrypted: Uint8Array,
	key: Buffer,
	host: string,
): string | null => {
	if (encrypted.length < 4) return null;
	const prefix = Buffer.from(encrypted.subarray(0, 3)).toString("ascii");
	if (prefix !== "v10" && prefix !== "v11") return null;
	try {
		const decipher = createDecipheriv(
			"aes-128-cbc",
			key,
			Buffer.alloc(16, " "),
		);
		let plain = Buffer.concat([
			decipher.update(encrypted.subarray(3)),
			decipher.final(),
		]);
		const hostDigest = createHash("sha256").update(host).digest();
		if (plain.length > 32 && plain.subarray(0, 32).equals(hostDigest))
			plain = plain.subarray(32);
		return plain.toString("utf8");
	} catch {
		return null;
	}
};

const safeStorageServiceCandidates = (source: string): string[] => {
	const words = source.trim().split(/\s+/).filter(Boolean);
	const withoutGenericSuffix =
		words.at(-1)?.toLowerCase() === "browser" ? words.slice(0, -1) : words;
	return [
		source,
		withoutGenericSuffix.join(" "),
		words[0] ?? "",
		words.at(-1) ?? "",
	]
		.filter(
			(value, index, values) =>
				value.length > 0 && values.indexOf(value) === index,
		)
		.map((value) => `${value} Safe Storage`);
};

const readSafeStoragePassword = async (
	source: string,
): Promise<string | null> => {
	for (const service of safeStorageServiceCandidates(source)) {
		const entries = await keytar.findCredentials(service).catch(() => []);
		const password = entries[0]?.password;
		if (password !== undefined) return password;
	}
	return null;
};

const readCookieRows = (db: DatabaseSync): Array<Record<string, unknown>> => {
	const statement = db.prepare(
		"SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies",
	);
	statement.setReadBigInts(true);
	return statement.all() as Array<Record<string, unknown>>;
};

const removeImportedIdentity = async (
	target: Session,
	identity: ImportedCookieIdentity,
): Promise<void> => {
	const scheme = identity.secure === false ? "http" : "https";
	const url = `${scheme}://${identity.domain.replace(/^\./, "")}${identity.path}`;
	if (identity.valueHash === undefined) return;
	const current = await target.cookies.get({ url, name: identity.name });
	const stillImported = current.some(
		(cookie) =>
			(cookie.domain ?? "").replace(/^\./, "") ===
				identity.domain.replace(/^\./, "") &&
			cookie.path === identity.path &&
			createHash("sha256").update(cookie.value).digest("hex") ===
				identity.valueHash,
	);
	if (!stillImported) return;
	await target.cookies.remove(url, identity.name).catch(() => {});
};

export const getBrowserCookieImportStatus = async (
	userData: string,
): Promise<BrowserCookieImportStatus> => {
	const state = await readState(userData);
	const { defaultProfile, profiles } = await detectProfiles();
	const detected =
		profiles.find((profile) => profile.id === state.selectedProfileId) ??
		defaultProfile ??
		profiles[0] ??
		null;
	return {
		supported: profiles.length > 0,
		availableProfiles: profiles.map((profile) => ({
			id: profile.id,
			source: profile.source,
			profile: profile.profile,
			isDefault: profile.id === defaultProfile?.id,
		})),
		...(detected === null
			? {}
			: {
					selectedProfileId: detected.id,
					source: detected.source,
					profile: detected.profile,
				}),
		...(state.lastImportTime === undefined
			? {}
			: { lastImportTime: state.lastImportTime }),
		importedDomainCount: new Set(
			state.identities.map((item) => item.domain.replace(/^\./, "")),
		).size,
		importedCookieCount: state.identities.length,
		importedDomains: [
			...new Set(
				state.identities.map((item) => item.domain.replace(/^\./, "")),
			),
		].sort(),
		...(detected === null
			? {
					message:
						"The default browser profile is unavailable or uses an unsupported cookie store.",
				}
			: {}),
	};
};

export const importDefaultBrowserCookies = async (
	userData: string,
	target: Session,
	selectedProfileId?: string,
): Promise<BrowserCookieImportStatus> => {
	const { defaultProfile, profiles } = await detectProfiles();
	const detected =
		(selectedProfileId === undefined
			? defaultProfile
			: profiles.find((profile) => profile.id === selectedProfileId)) ?? null;
	if (detected === null)
		throw new Error(
			"The default browser cookie profile is unavailable or unsupported.",
		);
	const password = await readSafeStoragePassword(detected.source);
	const key =
		password === null
			? null
			: pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
	const temporary = await fs.mkdtemp(
		Path.join(tmpdir(), "zuse-browser-import-"),
	);
	const snapshot = Path.join(temporary, "Cookies");
	try {
		await fs.copyFile(detected.cookieDb, snapshot);
		for (const suffix of ["-wal", "-shm"]) {
			try {
				await fs.copyFile(
					`${detected.cookieDb}${suffix}`,
					`${snapshot}${suffix}`,
				);
			} catch {
				/* optional SQLite sidecar */
			}
		}
		const db = new DatabaseSync(snapshot, { readOnly: true });
		let rows: Array<Record<string, unknown>>;
		try {
			rows = readCookieRows(db);
		} finally {
			db.close();
		}
		const previousState = await readState(userData);
		await Promise.all(
			previousState.identities.map((identity) =>
				removeImportedIdentity(target, identity),
			),
		);
		const now = Date.now() / 1000;
		const identities: ImportedCookieIdentity[] = [];
		for (const row of rows) {
			const domain = String(row.host_key ?? "");
			const name = String(row.name ?? "");
			const path = String(row.path ?? "/");
			if (domain.length === 0 || name.length === 0) continue;
			const rawExpiry = Number(row.expires_utc ?? 0);
			const expirationDate =
				rawExpiry > 0
					? rawExpiry / 1_000_000 - COOKIE_EPOCH_OFFSET_SECONDS
					: undefined;
			if (expirationDate !== undefined && expirationDate <= now) continue;
			let value = String(row.value ?? "");
			const encrypted = row.encrypted_value;
			if (value.length === 0 && encrypted instanceof Uint8Array && key !== null)
				value = decryptCookie(encrypted, key, domain) ?? "";
			if (value.length === 0) continue;
			try {
				const secure = Number(row.is_secure) === 1;
				const sameSite = Number(row.samesite);
				await target.cookies.set({
					url: `${secure ? "https" : "http"}://${domain.replace(/^\./, "")}${path}`,
					name,
					value,
					domain,
					path,
					secure,
					httpOnly: Number(row.is_httponly) === 1,
					...(expirationDate === undefined ? {} : { expirationDate }),
					...(sameSite < 0
						? {}
						: {
								sameSite:
									sameSite === 2
										? "strict"
										: sameSite === 1
											? "lax"
											: "no_restriction",
							}),
				});
				identities.push({
					domain,
					path,
					name,
					secure,
					valueHash: createHash("sha256").update(value).digest("hex"),
				});
			} catch {
				// Skip invalid individual records while preserving the rest of the import.
			}
		}
		const state = await readState(userData);
		await writeState(userData, {
			...state,
			selectedProfileId: detected.id,
			lastImportTime: new Date().toISOString(),
			source: detected.source,
			profile: detected.profile,
			identities,
		});
		return getBrowserCookieImportStatus(userData);
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
};

export const clearImportedBrowserCookies = async (
	userData: string,
	target: Session,
): Promise<BrowserCookieImportStatus> => {
	const state = await readState(userData);
	for (const item of state.identities) {
		await removeImportedIdentity(target, item);
	}
	await writeState(userData, {
		version: 1,
		migratedExistingSession: state.migratedExistingSession,
		...(state.selectedProfileId === undefined
			? {}
			: { selectedProfileId: state.selectedProfileId }),
		identities: [],
	});
	return getBrowserCookieImportStatus(userData);
};

export const BROWSER_PARTITION = PARTITION;

export const browserCookieImportInternals = {
	decryptCookie,
	parseDefaultHandlerBundle,
	readCookieRows,
	safeStorageServiceCandidates,
};
