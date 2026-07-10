export type ConnectionOptions = {
	readonly key: string;
	readonly endpoint: string;
	readonly token?: string | null;
};

export type ClientSession<Client> = {
	readonly client: Client;
	readonly dispose: () => Promise<void>;
};

export type ClientConnector<Options extends ConnectionOptions, Client> = (
	options: Options,
) => Promise<ClientSession<Client>>;
