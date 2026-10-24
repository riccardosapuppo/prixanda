// The guided creation: Continue stops on the first field to fix, with its own
// message; the example fills the form and the page beside it writes the
// price the Italian way; a role that only reads finds the fields read-only,
// no Save draft, and, when it reviews, the way to Approvals.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import { MARKETS, PLANS_IT, studentPass } from "../../stories/fixtures.ts";
import { fakeGateway, PEOPLE, StoryProviders } from "../../stories/support.tsx";
import type { Viewer } from "../../lib/react/session.tsx";
import { Wizard } from "./wizard.tsx";

function gatewayFor() {
  return fakeGateway({
    Markets: () => ({ markets: MARKETS }),
    Plans: () => ({ plans: PLANS_IT }),
    Change: () => ({ change: studentPass("DRAFT") }),
  });
}

function GuidedCreation({ viewer, gateway, changeId }: { readonly viewer: Viewer; readonly gateway: ReturnType<typeof gatewayFor>; readonly changeId: string | null }) {
  return (
    <StoryProviders gateway={gateway} viewer={viewer}>
      <Wizard changeId={changeId} />
    </StoryProviders>
  );
}

const meta = {
  title: "Screens/Guided creation",
  component: GuidedCreation,
  parameters: { route: { pathname: "/campaigns/new/", query: {} } },
} satisfies Meta<typeof GuidedCreation>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ContinueStopsOnTheFirstFieldToFix: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: gatewayFor(), changeId: null },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await userEvent.click(await page.findByRole("button", { name: "Continue" }));
    await expect(page.getByText("Give the campaign a name: it is how the team finds it.")).toBeInTheDocument();
    await expect(page.getByLabelText("Campaign name")).toHaveFocus();
    await expect(page.getByLabelText("Campaign name")).toHaveAttribute("aria-invalid", "true");
    await userEvent.type(page.getByLabelText("Campaign name"), "Student Autumn Pass");
    await expect(page.queryByText("Give the campaign a name: it is how the team finds it.")).toBeNull();
  },
};

export const TheExampleAndThePageBesideIt: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: gatewayFor(), changeId: null },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await userEvent.click(await page.findByRole("button", { name: "Fill in the Student Autumn Pass" }));
    await expect(page.getByLabelText("Campaign name")).toHaveValue("Student Autumn Pass");
    const preview = page.getByRole("figure");
    // Testing Library compares the page's text with its spaces collapsed; the
    // Italian way itself, a no-break space before the euro sign, is read as written.
    await expect((await within(preview).findByText("2,99 €")).textContent).toBe("2,99\u00a0€");
    await expect(within(preview).getByText("5,79 €", { selector: "s" }).textContent).toBe("5,79\u00a0€");
    await userEvent.click(page.getByRole("button", { name: "Before" }));
    await expect(within(preview).getByText(/No offer for this plan today/)).toBeInTheDocument();
  },
};

export const LockedForFinance: Story = {
  args: { viewer: PEOPLE["finance"]!, gateway: gatewayFor(), changeId: "7" },
  parameters: { route: { pathname: "/campaigns/edit/", query: { id: "7", step: "1" } } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(await page.findByText(/Marketing creates and submits campaigns\. As Finance you read this one, with its fields read-only, and you review it in Approvals\./)).toBeInTheDocument();
    await expect(page.getByRole("link", { name: "Open v3 in Approvals" })).toHaveAttribute("href", "/campaigns/approval/?id=7");
    await expect(page.getByLabelText("Campaign name")).toBeDisabled();
    await expect(page.queryByRole("button", { name: "Save draft" })).toBeNull();
  },
};
