import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { makeEnvironmentCommand } from "../../../src/drivers/environment-command.ts";

test("deployment receives the exact secret through stdin while observed output is masked", async () => {
	let received = "";
	const server = createServer((req, res) => {
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			received += chunk;
		});
		req.on("end", () => {
			res.end("deployed");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("No server address");
	const permission = vi.fn(async () => ({ _tag: "AllowOnce" as const }));
	const tool = makeEnvironmentCommand({
		cwd: tmpdir(),
		executionEnvironment: { DEPLOY_SECRET: "private-deployment-value" },
		requestPermission: permission,
		getRuntimeMode: () => "approval-required",
		getPermissionMode: () => "default",
	});
	try {
		const script = `let value="";process.stdin.setEncoding("utf8");process.stdin.on("data",s=>value+=s);process.stdin.on("end",async()=>{await fetch("http://127.0.0.1:${address.port}",{method:"POST",body:value});console.log(value)})`;
		const result = await tool.tool.execute(
			{
				command: `printf '%s' "$DEPLOY_SECRET" | '${process.execPath}' -e '${script}'`,
			},
			{},
		);
		expect(received).toBe("private-deployment-value");
		expect(result).not.toContain("private-deployment-value");
		expect(result).toContain("[secret]");
		expect(permission).toHaveBeenCalledTimes(1);
		expect(process.env.DEPLOY_SECRET).toBeUndefined();
	} finally {
		await tool.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("denied commands do not execute", async () => {
	const tool = makeEnvironmentCommand({
		cwd: tmpdir(),
		executionEnvironment: { TOKEN: "private" },
		requestPermission: async () => ({ _tag: "Deny" }),
		getRuntimeMode: () => "approval-required",
	});
	await expect(
		tool.tool.execute({ command: "echo $TOKEN" }, {}),
	).rejects.toThrow("denied");
	await tool.close();
});
