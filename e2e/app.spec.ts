import { test, expect, type Page } from '@playwright/test';

/** Run a transcript command and wait until it has finished (prompt back, not running). */
async function cmd(page: Page, text: string) {
  const before = await page.locator('.tr-out > *').count();
  await page.locator('.tr-in input').fill(text);
  await page.keyboard.press('Enter');
  await expect.poll(async () => page.locator('.tr-out > *').count()).toBeGreaterThan(before);
  await expect(page.locator('.run-ind.on')).toHaveCount(0);
}

async function fresh(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  // the first visit loads the counter example and runs its do-file
  await expect(page.locator('.tr-out')).toContainText('Loaded example');
  await expect(page.locator('.tr-out')).toContainText('$finish', { timeout: 30_000 });
  return errors;
}

test('first visit loads and runs the example', async ({ page }) => {
  const errors = await fresh(page);
  const project = page.locator('.pane-tab', { hasText: 'Project' });
  await project.click();
  for (const f of ['counter.v', 'tb_counter.v', 'run_counter.do']) await expect(page.locator('.pane-left .pane-page.active')).toContainText(f);
  await page.locator('.pane-tab', { hasText: 'Wave' }).click();
  await expect(page.locator('.wave-names .wave-row').first()).toBeVisible();
  expect(await page.locator('.wave-names .wave-row').count()).toBeGreaterThan(3);
  // only the active page of each pane is visible (no overlapping tabs)
  for (const pane of ['.pane-left', '.pane-mid', '.pane-right']) {
    const visible = await page.locator(`${pane} .pane-page`).evaluateAll(els => els.filter(e => (e as HTMLElement).offsetParent !== null).length);
    expect(visible, pane).toBe(1);
  }
  expect(errors).toEqual([]);
});

test('compile errors link to the source line', async ({ page }) => {
  await fresh(page);
  await page.evaluate(() => (window as any).websim.fs.write('bad.v', 'module bad;\n  wire x\n  assign x = 1;\nendmodule\n'));
  await cmd(page, 'vlog bad.v');
  const err = page.locator('.tr-out .tr-line.err', { hasText: /bad\.v\(\d+\)/ }).first();
  await expect(err).toBeVisible();
  await err.locator('.link').first().click();
  await expect(page.locator('.pane-right .pane-tab.active')).toHaveText(/bad\.v/);
  await expect(page.locator('.cm-error-line')).toHaveCount(1);
});

test('Start Simulation dialog loads the selected unit', async ({ page }) => {
  await fresh(page);
  await cmd(page, 'quit -sim');
  await page.locator('button[title="Start simulation…"]').click();
  const dlg = page.locator('.modal');
  await expect(dlg).toContainText('tb_counter');
  await dlg.locator('tr', { hasText: 'tb_counter' }).first().click();
  await dlg.locator('.btn.primary').click();
  await expect(page.locator('.tr-in .prompt')).toHaveText('VSIM 1>');
  await expect(page.locator('.pane-mid .pane-page.active')).toContainText('clk');
});

test('wave cursor shows values and the time', async ({ page }) => {
  await fresh(page);
  await page.locator('.pane-tab', { hasText: 'Wave' }).click();
  const canvas = page.locator('.wave-canvas-col');
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.4, box.y + 60);
  await expect(page.locator('.wave-foot')).toContainText('Cursor:');
  const values = await page.locator('.wave-values .wave-row').allTextContents();
  expect(values.some(v => /^[0-9a-fx]+$/i.test(v.trim()))).toBe(true);
  // zoom full keeps the whole run in view
  await page.keyboard.press('f');
  await expect(page.locator('.wave-foot')).toContainText('View: 0');
});

test('list, dataflow and coverage views', async ({ page }) => {
  await fresh(page);
  await cmd(page, 'vsim -coverage work.tb_counter');
  await cmd(page, 'add list /tb_counter/q');
  await cmd(page, 'run 100 ns');
  await expect(page.locator('.list-grid tbody tr').first()).toBeVisible();
  await page.locator('.pane-mid .pane-page.active tr', { hasText: 'q' }).first().click({ button: 'right' });
  await page.locator('.ctx-menu .menu-item', { hasText: 'Show in Dataflow' }).click();
  await expect(page.locator('.df-title')).toHaveText('/tb_counter/q');
  await expect(page.locator('.df-proc').first()).toBeVisible();
  await cmd(page, 'coverage report');
  await expect(page.locator('.tr-out')).toContainText('Toggle bits');
});

test('switches the UI to Korean and back', async ({ page }) => {
  await fresh(page);
  await page.getByText('View', { exact: true }).first().click();
  await page.getByText('한국어 (Korean)').click();
  await expect(page.getByText('파일', { exact: true }).first()).toBeVisible();
  await page.getByText('보기', { exact: true }).first().click();
  await page.getByText('English', { exact: true }).click();
  await expect(page.getByText('File', { exact: true }).first()).toBeVisible();
});
