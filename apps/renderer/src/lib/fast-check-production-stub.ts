const unavailable = (): never => {
	throw new Error(
		"Schema arbitrary generation is unavailable in the production renderer",
	);
};

export const anything = unavailable;
export const array = unavailable;
export const bigInt = unavailable;
export const boolean = unavailable;
export const constant = unavailable;
export const createDepthIdentifier = unavailable;
export const float = unavailable;
export const integer = unavailable;
export const object = unavailable;
export const oneof = unavailable;
export const record = unavailable;
export const shuffledSubarray = unavailable;
export const string = unavailable;
export const stringMatching = unavailable;
export const tuple = unavailable;
export const uniqueArray = unavailable;
