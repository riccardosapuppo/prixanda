// The guided writing of a prepaid pass. The commercial lead starts from the
// business book's example (§9.1): three months of Individual, €29.99 in
// Italy, a code valid 12 months; the plans offered are those anyone can have,
// so there is no Student pass (§9.3), and the page beside the form writes the
// price the Italian way. A checked version goes to Finance, condition 1. The
// on-call engineer reads it locked. While a first save creates the pass, its
// fields wait for the answer, and the page says so.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { MARKETS, PLANS_IT } from "../../stories/fixtures.ts";
import { giftPass } from "../../stories/prices.ts";
import { fakeGateway, PEOPLE, StoryProviders } from "../../stories/support.tsx";
import type { Viewer } from "../../lib/react/session.tsx";
import { PassEditor } from "./form.tsx";

function gatewayFor(change = giftPass("DRAFT")) {
  let submitted = false;
  return fakeGateway({
    Markets: () => ({ markets: MARKETS }),
    Plans: () => ({ plans: PLANS_IT }),
    Change: () => ({ change: submitted ? giftPass("IN_APPROVAL") : change }),
    SubmitChange: () => {
      submitted = true;
      return { submitChange: { __typename: "Change", ...giftPass("IN_APPROVAL") } };
    },
  });
}

/** A gateway on which creating the pass takes its time: the answer comes when release() says so. */
function slowCreation() {
  let release = () => {};
  const gateway = fakeGateway({
    Markets: () => ({ markets: MARKETS }),
    Plans: () => ({ plans: PLANS_IT }),
    Change: () => ({ change: giftPass("DRAFT") }),
    CreatePrepaidPass: () => new Promise((resolve) => {
      release = () => resolve({ createPrepaidPass: { __typename: "Change", ...giftPass("DRAFT") } });
    }),
  });
  return Object.assign(gateway, { release: () => release() });
}

function Writing({ viewer, gateway, changeId }: { readonly viewer: Viewer; readonly gateway: ReturnType<typeof gatewayFor> & { readonly release?: () => void }; readonly changeId: string | null }) {
  return (
    <StoryProviders gateway={gateway} viewer={viewer}>
      <PassEditor changeId={changeId} />
    </StoryProviders>
  );
}

const meta = {
  title: "Screens/Prepaid pass",
  component: Writing,
  parameters: { route: { pathname: "/passes/new/", query: {} } },
} satisfies Meta<typeof Writing>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TheGiftPassOfTheBook: Story = {
  args: { viewer: PEOPLE["lead"]!, gateway: gatewayFor(), changeId: null },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await userEvent.click(await page.findByRole("button", { name: "Fill in the three-month gift pass" }));
    await expect(page.getByLabelText("Pass name")).toHaveValue("Three-month gift pass");
    const plan = page.getByLabelText(/^Plan it gives/);
    await expect(plan).toHaveValue("individual");
    // A gift code cannot carry a student verification: no Student pass.
    await expect(within(plan).queryByRole("option", { name: "Student" })).toBeNull();
    await expect(page.getByRole("checkbox", { name: /^Italy/ })).toBeChecked();
    const preview = within(page.getByRole("complementary", { name: "The page as the site would show it" }));
    // The Italian way: a no-break space before the euro sign.
    await expect((await preview.findByText("29,99 €")).textContent).toBe("29,99 €");
    await expect(preview.getByText("Demonstration: no real payment")).toBeInTheDocument();
  },
};

export const ACheckedPassGoesToFinance: Story = {
  args: { viewer: PEOPLE["lead"]!, gateway: gatewayFor(giftPass("VALIDATED")), changeId: "24" },
  parameters: { route: { pathname: "/passes/edit/", query: { id: "24", step: "5" } } },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await expect(await page.findByLabelText("The change in business words")).toHaveTextContent("Three-month gift pass: Individual for 3 months, paid in advance and never renewed");
    await expect(page.getByText("Finance must sign: condition 1 of §7.3.", { selector: "span" })).toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Submit v1 for approval" }));
    await expect(await page.findByText("v1 is in approval.")).toBeInTheDocument();
    await expect(page.getByRole("link", { name: "Open the approval page" })).toHaveAttribute("href", "/passes/approval/?id=24");
    await waitFor(() => expect(args.gateway.calls.some((call) => call.operation === "SubmitChange")).toBe(true));
  },
};

export const ThePricesStepComparesTheMonthsAtTheListPrice: Story = {
  args: { viewer: PEOPLE["lead"]!, gateway: gatewayFor(), changeId: "24" },
  parameters: { route: { pathname: "/passes/edit/", query: { id: "24", step: "2" } } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByLabelText("Price in Italy, VAT included, paid once")).toHaveValue("29.99");
    // Individual at €10.49 a month is €31.47 for three months; the floor, €6.10 a month, €18.30.
    await expect(await page.findByText("€31.47")).toBeInTheDocument();
    await expect(page.getByText("€18.30")).toBeInTheDocument();
  },
};

export const TheOnCallEngineerReadsItLocked: Story = {
  args: { viewer: PEOPLE["onCall"]!, gateway: gatewayFor(giftPass("IN_APPROVAL")), changeId: "24" },
  parameters: { route: { pathname: "/passes/edit/", query: { id: "24", step: "1" } } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByText(/The commercial lead writes prepaid passes \(§12\)\. As On-call engineer you read this one, with its fields read-only\./)).toBeInTheDocument();
    await expect(page.getByLabelText("Pass name")).toBeDisabled();
    await expect(page.queryByRole("button", { name: "Save draft" })).toBeNull();
  },
};

export const WhileThePassIsCreatedItsFieldsWait: Story = {
  args: { viewer: PEOPLE["lead"]!, gateway: slowCreation(), changeId: null },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await userEvent.click(await page.findByRole("button", { name: "Fill in the three-month gift pass" }));
    await userEvent.click(page.getByRole("button", { name: "Save draft" }));
    // No answer yet: what is typed now would be lost when the pass opens on its own page, so the fields wait.
    await waitFor(() => expect(page.getByLabelText("Pass name")).toBeDisabled());
    await expect(page.getByText(/^Saving the new prepaid pass as v1\. The fields wait until it is saved/)).toBeInTheDocument();
    await expect(page.getByLabelText(/^Plan it gives/)).toBeDisabled();
    args.gateway.release?.();
    await waitFor(() => expect(args.gateway.calls.filter((call) => call.operation === "CreatePrepaidPass")).toHaveLength(1));
    const created = args.gateway.calls.find((call) => call.operation === "CreatePrepaidPass")?.variables as { readonly pass: { readonly title: string } };
    await expect(created.pass.title).toBe("Three-month gift pass");
  },
};
