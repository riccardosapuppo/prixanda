// Every story wears the console's own styles: the identity's theme, the two
// fonts, the shared components.
//
// The screens use the App Router's navigation (next/navigation). The
// framework's own App Router mock (nextjs.appDirectory) predates Next.js
// 16.4: its layout context lacks the render tree that 16.4's useRouter reads,
// so every story would stop on "Cannot read properties of undefined". The
// framework therefore runs in its pages mode, and this preview mounts the App
// Router's contexts itself: a router whose methods are spies, the pathname,
// the search parameters, and no layout context (useRouter then answers as at
// the root). A story names its address with parameters.route.
import "design/fonts/atkinson.css";
import "design/fonts/archivo.css";
import "../src/app/globals.css";
import type { Decorator, Loader, Preview } from "@storybook/nextjs-vite";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathParamsContext, PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { fn } from "storybook/test";

/** Where a story stands: the page's path and its query string. */
export type StoryRoute = { readonly pathname: string; readonly query?: Readonly<Record<string, string>> };

type Mounted = { readonly router: AppRouterInstance; readonly pathname: string; readonly searchParams: URLSearchParams };

const mountRoute: Loader = ({ parameters }) => {
  const route = (parameters["route"] as StoryRoute | undefined) ?? { pathname: "/" };
  const router: AppRouterInstance = {
    back: fn().mockName("router.back"),
    forward: fn().mockName("router.forward"),
    refresh: fn().mockName("router.refresh"),
    push: fn().mockName("router.push"),
    replace: fn().mockName("router.replace"),
    prefetch: fn().mockName("router.prefetch"),
    bfcacheId: "storybook",
  };
  const mounted: Mounted = { router, pathname: route.pathname, searchParams: new URLSearchParams(route.query ?? {}) };
  return { route: mounted };
};

const appRouter: Decorator = (Story, { loaded }) => {
  const { router, pathname, searchParams } = loaded["route"] as Mounted;
  return (
    <AppRouterContext.Provider value={router}>
      <PathParamsContext.Provider value={{}}>
        <PathnameContext.Provider value={pathname}>
          <SearchParamsContext.Provider value={searchParams}>
            <Story />
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </PathParamsContext.Provider>
    </AppRouterContext.Provider>
  );
};

const preview: Preview = {
  loaders: [mountRoute],
  decorators: [appRouter],
  parameters: {
    nextjs: { appDirectory: false },
    layout: "fullscreen",
    controls: { disable: true },
  },
};

export default preview;
