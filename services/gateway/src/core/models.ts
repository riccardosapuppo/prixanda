// The parents the resolvers receive, one per object type of the two schemas
// (tools/graphql.ts maps each type to its model here). Mostly the engine's own
// messages, as the contract defines them; a few small shapes of the gateway's
// where a type has no message of its own.
import type { AuditEvent, ChainHead, VerifyChainResponse } from "contracts/commerce/v1/audit";
import type { Entitlements, Market, Plan, PriceBreakdown, PriceChangePolicy, PriceListEntry, PublishedOffer } from "contracts/commerce/v1/catalog";
import type {
  Approval, Audience, Change, ChangeSummary, ChangeVersion, ListeningRule, ListPriceContent, MigrationProgress, OfferContent, OfferPage,
  OfferPeriod, OfferPrice, PriceMigrationContent, RequiredSignature, ValidationFinding, ValidationReport,
} from "contracts/commerce/v1/changes";
import type { LocalTime, Refusal } from "contracts/commerce/v1/common";
import type { LaunchIncident, LaunchRun, LaunchStep } from "contracts/commerce/v1/launches";
import type { GetOverviewResponse, Incident, Launch, MarketRevenue, Person, SubscriberCount } from "contracts/commerce/v1/overview";
import type { Quote } from "contracts/commerce/v1/quotes";
import type { Assumption, FinanceCondition, MigrationSimulation, PriceStep, SimulationResult, Totals } from "contracts/commerce/v1/simulation";
import type {
  Account, Confirmation, DemoListener, Payment, PriceChange, Receipt, StudentVerification, Subscription,
} from "contracts/commerce/v1/subscriptions";
import type { Listener, SessionInfo } from "./context.ts";

// The console's schema.
export type PersonModel = Person;
export type SessionModel = SessionInfo;
export type MarketModel = Market;
export type EntitlementsModel = Entitlements;
export type PriceBreakdownModel = PriceBreakdown;
export type PlanModel = Plan;
export type PriceListEntryModel = PriceListEntry;
export type ChangePageModel = { readonly nodes: readonly ChangeSummary[]; readonly next: string | null };
export type ChangeSummaryModel = ChangeSummary;
export type ChangeModel = Change;
export type ChangeVersionModel = ChangeVersion;
export type OfferContentModel = OfferContent;
export type ListPriceContentModel = ListPriceContent;
export type AudienceModel = Audience;
export type ListeningRuleModel = ListeningRule;
export type OfferPriceModel = OfferPrice;
export type OfferPeriodModel = OfferPeriod;
export type OfferPageModel = OfferPage;
export type ApprovalModel = Approval;
export type RequiredSignatureModel = RequiredSignature;
export type FactModel = { readonly name: string; readonly value: string };
export type ValidationFindingModel = ValidationFinding;
export type ValidationReportModel = ValidationReport;
/**
 * A refusal, and the change it is about when there is one: with STALE_VERSION
 * the client gets the newer version in the same answer (§6.3). Its $typeName
 * tells it apart from the engine's messages in a union, as theirs do.
 */
export type RefusalModel = { readonly $typeName: "gateway.Refusal"; readonly refusal: Refusal; readonly changeId: string | null };
export type OverviewModel = GetOverviewResponse;
export type MarketTimeModel = LocalTime;
export type LaunchModel = Launch;
export type IncidentModel = Incident;
export type SubscriberCountModel = SubscriberCount;
export type MarketRevenueModel = MarketRevenue;
export type AssumptionModel = Assumption;
export type TotalsModel = Totals;
export type FinanceConditionModel = FinanceCondition;
export type SimulationModel = SimulationResult;
export type AuditEventModel = AuditEvent;
export type AuditPageModel = { readonly nodes: readonly AuditEvent[]; readonly next: string | null };
export type ChainHeadModel = ChainHead;
export type ChainVerificationModel = VerifyChainResponse;
export type LaunchPageModel = { readonly nodes: readonly LaunchRun[]; readonly next: string | null };
export type LaunchRunModel = LaunchRun;
export type LaunchStepModel = LaunchStep;
export type LaunchIncidentModel = LaunchIncident;
/**
 * A market's policy for price changes, in two parts never mixed (§8.1): the
 * law and the music service's choice. One message of the contract, each part
 * reading its own fields of it.
 */
export type PriceChangePolicyModel = PriceChangePolicy;
export type PriceChangeLawModel = PriceChangePolicy;
export type PriceChangeChoiceModel = PriceChangePolicy;
export type MigrationProgressModel = MigrationProgress;
export type PriceMigrationContentModel = PriceMigrationContent;
export type PriceStepModel = PriceStep;
export type MigrationSimulationModel = MigrationSimulation;

// The site's schema: the same messages, read through fewer fields.
export type PublicMarketModel = Market;
export type PublicEntitlementsModel = Entitlements;
export type PublicPriceBreakdownModel = PriceBreakdown;
export type PublicPlanModel = Plan;
export type PublicListPriceModel = PriceListEntry;
export type PublicMarketTimeModel = LocalTime;
export type PublicOfferModel = PublishedOffer;
export type PublicQuoteModel = Quote;
export type PublicDemoListenerModel = DemoListener;
/** The site's session: the listener chosen at the entrance, its CSRF token and expiry. */
export type PublicMeModel = SessionInfo<Listener>;
export type PublicAccountModel = Account;
export type PublicSubscriptionModel = Subscription;
export type PublicStudentVerificationModel = StudentVerification;
export type PublicPaymentModel = Payment;
export type PublicReceiptModel = Receipt;
/** The engine's confirmation: its payment, or, from an engine that charged at the confirmation, only its receipt. */
export type PublicConfirmationModel = Confirmation;
export type PublicPriceChangeModel = PriceChange;
/** A refusal as the site may say it: a public code, and a sentence written for a visitor. */
export type PublicRefusalModel = {
  readonly $typeName: "gateway.PublicRefusal";
  readonly code: PublicRefusalCode;
  readonly reason: string;
};
export type PublicRefusalCode =
  | "OFFER_ENDED" | "QUOTE_EXPIRED" | "NOT_ELIGIBLE" | "ALREADY_SUBSCRIBED" | "NOT_COMBINABLE" | "CAP_REACHED" | "PAYMENT_DECLINED" | "ANSWER_CLOSED"
  | "NOT_AVAILABLE";
