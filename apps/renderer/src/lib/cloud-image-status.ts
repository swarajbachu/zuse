import type { CloudAccountImage } from "@zuse/contracts";

export const cloudImageStatusMessage = (
	image: CloudAccountImage | undefined,
) => {
	if (image?.source === "custom-snapshot" || image?.snapshot !== undefined) {
		if (image.state === "building") return "settings:snapshot_inspecting";
		if (image.state !== "ready") return "settings:snapshot_attention";
	}
	return `settings:cloud_images_state_${image?.state ?? "checking"}` as const;
};
