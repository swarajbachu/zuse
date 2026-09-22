import { expect, test } from "vitest";
import { moveProject, orderProjects } from "../../../src/lib/project-order";

test("saved project order survives input changes and appends new projects", () => {
	expect(
		orderProjects(["c", "b", "new", "a"], ["a", "b", "c"], (key) => key),
	).toEqual(["a", "b", "c", "new"]);
});
test("drag offsets move a project and clamp at list edges", () => {
	expect(moveProject(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
	expect(moveProject(["a", "b", "c"], 2, -99)).toEqual(["c", "a", "b"]);
	expect(moveProject(["a", "b"], -1, 1)).toEqual(["a", "b"]);
});
