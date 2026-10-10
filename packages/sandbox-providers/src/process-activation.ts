import type { SandboxProcessInput } from "./index.ts";

export const processShellQuote = (value: string): string =>
	`'${value.replaceAll("'", `'\\''`)}'`;

export const rootProcessCommand = (script: string): string => {
	// Encoded scripts keep cleanup markers out of their parent's argv.
	const encoded = btoa(
		Array.from(new TextEncoder().encode(script), (byte) =>
			String.fromCharCode(byte),
		).join(""),
	);
	return `sudo -n -E bash -c ${processShellQuote(`eval "$(printf %s ${encoded} | base64 -d)"`)}`;
};

export const processActivationDescription = (
	activation: SandboxProcessInput["activation"],
): string =>
	activation === undefined
		? "Zuse-managed-process"
		: `Zuse-managed-process:${activation.generation}:${activation.operationId}`;

/** One persistent ownership fence for every guest process backend. */
export const processActivationGuard = (
	input: SandboxProcessInput,
	unit: string,
	observeSameOperation: ReadonlyArray<string>,
): string[] => {
	const activation = input.activation;
	if (!/^[a-zA-Z0-9_.@:-]+\.service$/.test(unit) || unit.length > 255)
		throw new Error("Invalid managed process unit");
	if (
		activation !== undefined &&
		(!Number.isSafeInteger(activation.generation) ||
			activation.generation < 1 ||
			!/^[a-zA-Z0-9_.:-]{1,128}$/.test(activation.operationId))
	)
		throw new Error("Invalid managed process activation");
	return [
		"set -e",
		`activation_dir=${processShellQuote(`/var/lib/zuse-process-activations/${unit}`)}`,
		'install -d -m 0700 -o root -g root /var/lib/zuse-process-activations "$activation_dir"',
		"umask 077",
		'exec 9>"$activation_dir/lock"',
		"flock -x 9",
		'journal="$activation_dir/owner"',
		...(activation === undefined
			? ['test ! -e "$journal"']
			: [
					`generation=${activation.generation}`,
					`operation=${processShellQuote(activation.operationId)}`,
					'if [ -e "$journal" ]; then',
					'  read -r previous_generation previous_operation extra < "$journal"',
					'  [[ "$previous_generation" =~ ^[1-9][0-9]{0,15}$ ]] && [ -n "$previous_operation" ] && [ -z "$extra" ]',
					'  [ "$previous_generation" -le "$generation" ]',
					'  if [ "$previous_generation" -eq "$generation" ]; then',
					'    [ "$previous_operation" = "$operation" ]',
					...observeSameOperation,
					"  fi",
					"fi",
					// Persist intent before touching the previous process. Interrupted
					// activation is resumable; delayed workers remain fenced out.
					'temporary="$activation_dir/owner.next.$$"',
					"trap 'rm -f \"$temporary\"' EXIT",
					'printf "%s %s\\n" "$generation" "$operation" > "$temporary"',
					'sync -f "$temporary"',
					'mv -f "$temporary" "$journal"',
					'sync -f "$activation_dir"',
				]),
	];
};
