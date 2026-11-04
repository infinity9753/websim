// Screenshots for README / GUIDE (npm run screenshots). One test walks through the app like a user and saves each
// view to docs/images/. Every step waits for its result, so a broken flow fails here instead of producing a bad image.
import { test, expect, type Page } from '@playwright/test';

const OUT = 'docs/images';

async function cmd(page: Page, text: string, timeout = 120_000) {
  const before = await page.locator('.tr-out > *').count();
  await page.locator('.tr-in input').fill(text);
  await page.keyboard.press('Enter');
  await expect.poll(async () => page.locator('.tr-out > *').count(), { timeout }).toBeGreaterThan(before);
  await expect(page.locator('.run-ind.on')).toHaveCount(0, { timeout });
}

const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}.png` });
const menu = async (page: Page, top: string, item: string) => {
  await page.getByText(top, { exact: true }).first().click();
  await page.locator('.menu-item', { hasText: item }).first().click();
};

test('documentation screenshots', async ({ page }) => {
  await page.goto('/');
  // the first visit loads the OpenTPU example, runs it and shows its waves
  await expect(page.locator('.tr-out')).toContainText('$finish', { timeout: 60_000 });
  await page.waitForTimeout(500);
  await shot(page, 'overview');

  // the 8-bit CPU example: simulation with waves
  await cmd(page, 'quit -sim');
  await cmd(page, 'vdel -lib work -all');
  await menu(page, 'File', 'Load Example');
  await page.locator('.menu-item', { hasText: '8-bit CPU' }).last().click();
  await expect(page.locator('.tr-out')).toContainText('Halted at', { timeout: 30_000 });
  await page.waitForTimeout(500);
  await shot(page, 'cpu-waves');
  await cmd(page, 'quit -sim');

  // synthesis to the educational cells: gate schematic
  await menu(page, 'Compile', 'Synthesize (Yosys)');
  await page.locator('.synth-view select[aria-label="Target"]').selectOption('asic');
  await page.locator('.synth-view button[title="Synthesize with Yosys"]').click();
  await expect(page.locator('.synth-view .synth-status')).toContainText('cpu (asic)', { timeout: 120_000 });
  await expect(page.locator('.syn-sym').first()).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, 'synthesis');

  // FPGA place and route (iCE40)
  await menu(page, 'Compile', 'Place & Route (nextpnr)');
  await page.locator('.pnr select[aria-label="Device"]').selectOption('hx1k');
  await page.locator('.pnr button[title="Synthesize, place and route"]').click();
  await expect(page.locator('.pnr .synth-status')).toContainText('logic cells', { timeout: 240_000 });
  await page.waitForTimeout(500);
  await shot(page, 'pnr-ice40');

  // the ASIC flow with constraints: layout with the critical path
  await menu(page, 'Compile', 'ASIC Flow (layout, GDSII)');
  await page.locator('.chip input[aria-label="SDC file"]').fill('cpu.sdc');
  await page.locator('.chip button[title="Synthesize, place and route (ASIC)"]').click();
  await expect(page.locator('.chip .synth-status')).toContainText('Timing (SDC)', { timeout: 120_000 });
  await page.locator('.chip').getByText('Critical path', { exact: true }).click();
  await page.waitForTimeout(500);
  await shot(page, 'asic-layout');

  // a static timing path report in a tall transcript
  await page.evaluate(() => (document.querySelector('.main') as HTMLElement).style.setProperty('--bottom-h', '800px'));
  await cmd(page, 'sta -paths 1 -hold');
  await page.waitForTimeout(300);
  await page.locator('.pane-bottom').screenshot({ path: `${OUT}/sta-report.png` });
});
