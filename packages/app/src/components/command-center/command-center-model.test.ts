import { expect, test } from "bun:test"
import { flattenTaskGraph, pageLimit } from "./command-center-model"

test("command center flattens a bounded DAG and clamps page sizes", () => {
  expect(pageLimit(500)).toBe(200)
  expect(flattenTaskGraph({
    tasks: [
      { task_id: "root", parent_task_id: null, depth: 0, state: "running" },
      { task_id: "child", parent_task_id: "root", depth: 1, state: "waiting" },
    ],
    edges: [],
  })).toEqual(["root", "child"])
})
