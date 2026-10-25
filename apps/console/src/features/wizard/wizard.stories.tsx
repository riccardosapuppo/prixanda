// The guided creation: Continue stops on the first field to fix, with its own
// message; the example fills the form and the page beside it writes the
// price the Italian way; a role that only reads finds the fields read-only,
// no Save draft, and, when it reviews, the way to Approvals; a save refused
// late, after the person loaded the newer version, does not bring the
// conflict back; and while a first save creates the campaign, its fields wait
// for the answer, and the page says so.
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { type Change, MARKETS, PLANS_IT, studentPass } from "../../stories/fixtures.ts";
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

/** The pass as a draft at one of its versions, as the engine would answer it then. */
function draftAt(version: 1 | 2): Change {
  const pass = studentPass("DRAFT");
  const current = pass.versions.find((entry) => entry.version === version) ?? pass.current;
  return { ...pass, currentVersion: version, versions: pass.versions.filter((entry) => entry.version <= version), current, requiredSignatures: [], sentence: null };
}

/**
 * A gateway on which someone else saved v2 while this page edits v1: every
 * save from v1 is refused as stale, the first one at once, the next ones only
 * when release() says so.
 */
function staleGateway() {
  let release = () => {};
  const refused = () => ({
    saveOfferVersion: { __typename: "Refusal", code: "STALE_VERSION", reason: "Version 2 was saved after the version you edited.", facts: [], change: draftAt(2) },
  });
  const gateway = fakeGateway({
    Markets: () => ({ markets: MARKETS }),
    Plans: () => ({ plans: PLANS_IT }),
    Change: (_variables: unknown, calls) => ({ change: calls.some((call) => call.operation === "SaveOfferVersion") ? draftAt(2) : draftAt(1) }),
    SaveOfferVersion: (_variables: unknown, calls) => calls.filter((call) => call.operation === "SaveOfferVersion").length === 1
      ? refused()
      : new Promise((resolve) => {
        release = () => resolve(refused());
      }),
  });
  return Object.assign(gateway, { release: () => release() });
}

/** A gateway on which creating the campaign takes its time: the answer comes when release() says so. */
function slowCreation() {
  let release = () => {};
  const gateway = fakeGateway({
    Markets: () => ({ markets: MARKETS }),
    Plans: () => ({ plans: PLANS_IT }),
    Change: () => ({ change: studentPass("DRAFT") }),
    CreateOffer: () => new Promise((resolve) => {
      release = () => resolve({ createOffer: { __typename: "Change", ...studentPass("DRAFT") } });
    }),
  });
  return Object.assign(gateway, { release: () => release() });
}

function GuidedCreation({ viewer, gateway, changeId }: { readonly viewer: Viewer; readonly gateway: ReturnType<typeof gatewayFor> & { readonly release?: () => void }; readonly changeId: string | null }) {
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

export const ALateRefusalDoesNotBringTheConflictBack: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: staleGateway(), changeId: "7" },
  parameters: { route: { pathname: "/campaigns/edit/", query: { id: "7", step: "1" } } },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await userEvent.type(await page.findByLabelText("Campaign name"), ", mine");
    // The first save is refused at once: v2 was saved meanwhile.
    await userEvent.click(page.getByRole("button", { name: "Save draft" }));
    await expect(await page.findByText("Someone saved v2 while you were editing v1.")).toBeInTheDocument();
    // A second save leaves from v1; before its answer, the person loads v2.
    await userEvent.click(page.getByRole("button", { name: "Save draft" }));
    await userEvent.click(page.getByRole("button", { name: "Load v2 and drop my edits" }));
    await expect(page.getByLabelText("Campaign name")).toHaveValue("Student Autumn Pass");
    await expect(page.queryByText(/while you were editing/)).toBeNull();
    // The late answer refuses a save made from v1, which the form no longer stands on.
    args.gateway.release?.();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(page.queryByText(/while you were editing/)).toBeNull();
  },
};

export const WhileTheCampaignIsCreatedItsFieldsWait: Story = {
  args: { viewer: PEOPLE["marketing"]!, gateway: slowCreation(), changeId: null },
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement);
    await userEvent.click(await page.findByRole("button", { name: "Fill in the Student Autumn Pass" }));
    await userEvent.click(page.getByRole("button", { name: "Save draft" }));
    // No answer yet: what is typed now would be lost when the campaign opens on its own page, so the fields wait.
    await waitFor(() => expect(page.getByLabelText("Campaign name")).toBeDisabled());
    await expect(page.getByText(/^Saving the new campaign as v1\. The fields wait until it is saved/)).toBeInTheDocument();
    await expect(page.getByRole("checkbox", { name: /^Italy/ })).toBeDisabled();
    args.gateway.release?.();
    await waitFor(() => expect(args.gateway.calls.filter((call) => call.operation === "CreateOffer")).toHaveLength(1));
    const created = args.gateway.calls.find((call) => call.operation === "CreateOffer")?.variables as { readonly offer: { readonly title: string } };
    await expect(created.offer.title).toBe("Student Autumn Pass");
  },
};
