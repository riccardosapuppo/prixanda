// The console in the demo's sandbox (stage 8): the start that says the
// worker's steps, the browser that cannot run the demo and is told why, the
// foot with the panel about the sandbox and Start over behind a confirmation,
// and the rail's "Try this", its steps ticked by the engine's facts and this
// browser's record, with the demo's controls: a simulated fault armed, then
// the skip to the launch, which says where the demo's clock went.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { GuideRecord } from "../lib/guide.ts";
import { forgetGuide, recordGuide, SandboxProvider } from "../lib/react/sandbox.tsx";
import { MARKETS, studentPass } from "../stories/fixtures.ts";
import { demoThatCannotRun, type FakeDemo, fakeDemo } from "../stories/sandbox.ts";
import { fakeGateway, PEOPLE, StoryProviders } from "../stories/support.tsx";
import { DemoPanel, SandboxFoot, SandboxStart } from "./sandbox.tsx";

function Demo({ demo, guide, change }: { readonly demo: FakeDemo; readonly guide?: Partial<GuideRecord>; readonly change?: "SCHEDULED" | null }) {
  const [gateway] = useState(() => fakeGateway({
    Change: () => ({ change: change ? studentPass(change, true) : null }),
    LaunchRuns: () => ({ launches: { nodes: [], next: null }, markets: MARKETS }),
  }));
  // This browser's record of "Try this", as the story needs it, before anything reads it.
  useState(() => {
    forgetGuide();
    if (guide) recordGuide(guide);
    return null;
  });
  return (
    <StoryProviders gateway={gateway} viewer={PEOPLE["marketing"]!}>
      <SandboxProvider sandbox={demo.sandbox}>
        <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[14.5rem_minmax(0,1fr)]">
          <div className="rail grid content-start gap-4 px-3 py-6">
            <DemoPanel shown />
          </div>
          <div className="flex min-w-0 flex-col">
            <div className="p-6">
              <SandboxStart />
            </div>
            <SandboxFoot />
          </div>
        </div>
      </SandboxProvider>
    </StoryProviders>
  );
}

const meta = {
  title: "Demo/Sandbox",
  component: Demo,
} satisfies Meta<typeof Demo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TheStartSaysTheWorkersSteps: Story = {
  args: { demo: fakeDemo({ state: { kind: "starting", step: "Loading the engine's Python code", done: 3, of: 6 } }) },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const start = await page.findByRole("status", { name: "Starting the demo in this browser" });
    await expect(start).toHaveTextContent("Loading the engine's Python code");
    await expect(within(start).getByRole("progressbar", { name: "Starting the demo" })).toHaveAttribute("aria-valuenow", "3");
    await expect(start).toHaveTextContent("Step 3 of 6. Nothing is sent anywhere");
    await expect(page.getByText("The demo's controls come once it has started.")).toBeInTheDocument();
  },
};

export const ABrowserThatCannotRunTheDemoIsToldWhy: Story = {
  args: { demo: demoThatCannotRun("IndexedDB") },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const alert = await page.findByRole("alert");
    await expect(alert).toHaveTextContent("The demo cannot run in this browser");
    await expect(alert).toHaveTextContent("This browser has no IndexedDB here, which the demo needs.");
    await expect(alert).toHaveTextContent("outside a private window");
    await expect(within(alert).getByRole("button", { name: "Reload the page" })).toBeInTheDocument();
  },
};

export const AboutThisSandboxAndStartOver: Story = {
  args: { demo: fakeDemo({ state: { kind: "ready" } }) },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await expect(page.getByText(/^Your data stays in this browser\./)).toBeInTheDocument();
    await expect(page.getByRole("link", { name: "GitHub" })).toHaveAttribute("href", expect.stringMatching(/^https:\/\/github\.com\//));
    const toggle = page.getByRole("button", { name: "About this sandbox" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    const about = page.getByRole("region", { name: "About this sandbox" });
    for (const part of ["Where your data is", "Starting over", "What it cannot do", "Simulated", "The real thing"]) await expect(within(about).getByText(part)).toBeInTheDocument();
    await userEvent.click(within(about).getByRole("button", { name: "Start over" }));
    const dialog = await page.findByRole("dialog", { name: "Start over?" });
    await expect(dialog).toHaveTextContent("Every change made in this browser is lost, in every tab");
    await expect(within(dialog).getByRole("button", { name: "Keep my changes" })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole("button", { name: "Yes, start over" }));
    await waitFor(() => expect(args.demo.commands).toContain("reset"));
    // The worker tells every tab, and each reloads: until then the dialog says it is starting over.
    await expect(await within(dialog).findByRole("button", { name: "Starting over" })).toBeDisabled();
  },
};

export const TryThisTicksItsStepsAndTheControlsSkipToTheLaunch: Story = {
  args: {
    demo: fakeDemo({ state: { kind: "ready" }, now: "2026-10-25T08:42:00Z", nextDue: "2026-10-26T07:59:00Z" }),
    guide: { changeId: "7", triedOwn: true, siteOpened: true },
    change: "SCHEDULED",
  },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    const steps = page.getByRole("region", { name: "Try this" });
    await waitFor(() => expect(within(steps).getAllByText(/^Done:/)).toHaveLength(5));
    const current = within(steps).getAllByRole("listitem").find((item) => item.getAttribute("aria-current") === "step");
    await expect(current).toHaveTextContent("6. Cause a fault, then skip to the launch");

    const controls = page.getByRole("region", { name: "Demo controls" });
    await expect(await within(controls).findByText("The next launch is due 26 Oct 08:59 Rome.")).toBeInTheDocument();
    await expect(within(controls).getByText("Simulated, and said so: real faults run on the full system (§14.6).")).toBeInTheDocument();
    await userEvent.selectOptions(within(controls).getByLabelText("Cause a fault at the step"), "publish");
    await userEvent.click(within(controls).getByRole("button", { name: "Arm" }));
    await expect(await within(controls).findByText("Fault armed at publish.")).toBeInTheDocument();
    await userEvent.click(within(controls).getByRole("button", { name: "Skip to the launch" }));
    await expect(await within(controls).findByText(
      "The demo's clock moved from 25 Oct 09:42 Rome to 26 Oct 09:00 Rome, the change's start: its launch ran, met the simulated fault at publish and recovered. Launches show it step by step.",
    )).toBeInTheDocument();
    await expect(args.demo.commands).toEqual(expect.arrayContaining(["status", "arm-fault", "skip-to-next-launch"]));
  },
};
