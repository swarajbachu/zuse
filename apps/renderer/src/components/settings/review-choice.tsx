import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "../ui/select.tsx";
import { CloudSettingsRow } from "./cloud-settings-ui.tsx";
export function ReviewChoice({
	label,
	value,
	options,
	onChange,
	disabled = false,
}: {
	label: string;
	value: string;
	options: readonly { value: string; label: string; disabled?: boolean }[];
	onChange: (value: string) => void;
	disabled?: boolean;
}) {
	return (
		<CloudSettingsRow
			title={label}
			action={
				<Select
					value={value || null}
					onValueChange={(value) => onChange(value ?? "")}
					disabled={disabled}
					items={options}
				>
					<SelectTrigger className="h-7 w-52 max-w-full" aria-label={label}>
						<SelectValue placeholder={label} />
					</SelectTrigger>
					<SelectPopup>
						{options.map((option) => (
							<SelectItem
								key={option.value}
								value={option.value}
								disabled={option.disabled}
							>
								{option.label}
							</SelectItem>
						))}
					</SelectPopup>
				</Select>
			}
		/>
	);
}
