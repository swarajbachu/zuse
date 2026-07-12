const Module = require("node:module");

const credentials = new Map();
const key = (service, account) => `${service}\0${account}`;
const keytar = {
	getPassword: async (service, account) =>
		credentials.get(key(service, account)) ?? null,
	setPassword: async (service, account, password) => {
		credentials.set(key(service, account), password);
	},
	deletePassword: async (service, account) =>
		credentials.delete(key(service, account)),
	findCredentials: async (service) => {
		const prefix = `${service}\0`;
		return [...credentials.entries()]
			.filter(([entry]) => entry.startsWith(prefix))
			.map(([entry, password]) => ({
				account: entry.slice(prefix.length),
				password,
			}));
	},
};

const load = Module._load;
Module._load = function loadWithEphemeralKeytar(request, parent, isMain) {
	if (request === "keytar") return keytar;
	return load.call(this, request, parent, isMain);
};
