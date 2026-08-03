import { expect, test } from "@playwright/test"

test("command center progressively discloses bounded supervision panels", async ({ page }) => {
  await page.goto("/RDpcRGV2RXh0ZW5zaW9uXFVsdHJhQ29kZVx1bHRyYWNvZGU/command-center")
  await expect(page.locator('[data-component="ultracode-command-center"]')).toBeVisible()
  await expect(page.getByRole("button", { name: "tasks" })).toBeVisible()
  await expect(page.getByRole("button", { name: "approvals" })).toBeVisible()
  await page.getByRole("button", { name: "inspector" }).click()
  await expect(page.getByText("Context & Token Inspector")).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole("button", { name: "plugins" })).toHaveCSS("min-height", "44px")
})
