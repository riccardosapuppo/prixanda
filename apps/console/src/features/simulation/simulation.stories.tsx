// The simulation opens on its verdict; a typed assumption goes to the engine
// as an override, the verdict follows, and the source says who typed it.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { MARKETS, simulation, studentPass } from "../../stories/fixtures.ts";
import { fakeGateway, PEOPLE, StoryProviders } from "../../stories/support.tsx";
import type { Viewer } from "../../lib/react/session.tsx";
import { SimulationScreen } from "./simulation.tsx";

function gatewayFor() {
  return fakeGateway({
    Change: () => ({ change: studentPass() }),
    Markets: () => ({ markets: MARKETS }),
    SimulateOffer: (variables: { overrides: { name: string; value: number }[] | null }) => {
      const retention = variables.overrides?.find((override) => override.name === "RETENTION")?.value;
      return { simulateOffer: simulation(retention === 7000 ? 7000 : 5500) };
    },
  });
}

function Simulation({ viewer, gateway }: { readonly viewer: Viewer; readonly gateway: ReturnType<typeof gatewayFor> }) {
  return (
    <StoryProviders gateway={gateway} viewer={viewer}>
      <SimulationScreen />
    </StoryProviders>
  );
}

const meta = {
  title: "Screens/Simulation",
  component: Simulation,
  parameters: { route: { pathname: "/campaigns/simulation/", query: { id: "7" } } },
} satisfies Meta<typeof Simulation>;
export default meta;
type Story = StoryObj<typeof meta>;

export const VerdictThenATypedRetention: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: gatewayFor() },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await expect(await page.findByRole("heading", { name: /At these assumptions the campaign loses €1,877\.51 over 12 months in Italy\./ })).toBeInTheDocument();
    await expect(page.getByText("It breaks even if at least 65.55% of takers stay at the list price.")).toBeInTheDocument();
    const retention = page.getByRole("textbox", { name: /^Retention/ });
    await userEvent.clear(retention);
    await userEvent.type(retention, "70{Enter}");
    await expect(await page.findByRole("heading", { name: /At these assumptions the campaign earns €788\.65/ })).toBeInTheDocument();
    await expect(page.getByText(/Typed by Marketing at 24 Oct 10:42 Rome/)).toBeInTheDocument();
    const sent = args.gateway.calls.filter((call) => call.operation === "SimulateOffer").at(-1)?.variables as { overrides: unknown };
    await expect(sent.overrides).toEqual([{ name: "RETENTION", value: 7000 }]);
    // A share that is not one is said under the field and not sent.
    await userEvent.clear(retention);
    await userEvent.type(retention, "140{Enter}");
    await expect(await page.findByText("A share from 0 to 100, like 12 or 12.5.")).toBeInTheDocument();
    await waitFor(() => expect(args.gateway.calls.filter((call) => call.operation === "SimulateOffer")).toHaveLength(2));
  },
};

export const LockedForTheAuditor: Story = {
  args: { viewer: PEOPLE["auditor"]!, gateway: gatewayFor() },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await expect(await page.findByText(/Marketing, the commercial lead and Finance run simulations\./)).toBeInTheDocument();
    await expect(args.gateway.calls.some((call) => call.operation === "SimulateOffer")).toBe(false);
  },
};
