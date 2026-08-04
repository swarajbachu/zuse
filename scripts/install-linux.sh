#!/usr/bin/env sh

set -eu

repository="swarajbachu/zuse"
api_url="https://api.github.com/repos/${repository}/releases/latest"

case "$(uname -m)" in
	x86_64 | amd64) ;;
	*)
		echo "Zuse currently provides Linux installers for x86_64 only." >&2
		exit 1
		;;
esac

for command in awk curl sed sha256sum; do
	if ! command -v "$command" >/dev/null 2>&1; then
		echo "Missing required command: $command" >&2
		exit 1
	fi
done

temporary_directory="$(mktemp -d)"
release_metadata_path="${temporary_directory}/release.json"
installer_path="${temporary_directory}/zuse.deb"
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM

curl --fail --location --silent --show-error \
	--header "Accept: application/vnd.github+json" \
	"$api_url" \
	--output "$release_metadata_path"

asset_url="$(sed -n \
	-e 's/.*"browser_download_url": "\([^"]*linux-x86_64\.deb\)".*/\1/p' \
	-e 's/.*"browser_download_url": "\([^"]*linux-amd64\.deb\)".*/\1/p' \
	-e 's/.*"browser_download_url": "\([^"]*linux-x64\.deb\)".*/\1/p' \
	"$release_metadata_path" | sed -n '1p')"

if [ -z "$asset_url" ]; then
	echo "The latest Zuse release does not contain a Linux .deb installer yet." >&2
	echo "Check https://github.com/${repository}/releases" >&2
	exit 1
fi

asset_name="${asset_url##*/}"
asset_digest="$(awk -v asset_name="$asset_name" '
	index($0, "\"name\": \"" asset_name "\"") { selected = 1; next }
	selected && /"digest": "sha256:/ {
		gsub(/^.*"digest": "sha256:|".*$/, "")
		print
		exit
	}
' "$release_metadata_path")"

if [ -z "$asset_digest" ]; then
	echo "GitHub did not provide a SHA-256 digest for ${asset_name}." >&2
	exit 1
fi

echo "Downloading the latest Zuse Linux installer..."
curl --fail --location --show-error --progress-bar "$asset_url" --output "$installer_path"
printf '%s  %s\n' "$asset_digest" "$installer_path" | sha256sum --check --status
echo "Verified ${asset_name}."

if command -v apt >/dev/null 2>&1; then
	echo "Installing Zuse with apt..."
	sudo apt install "$installer_path"
else
	echo "This installer requires a Debian/Ubuntu-based system with apt." >&2
	echo "Download the AppImage instead: https://github.com/${repository}/releases/latest" >&2
	exit 1
fi
