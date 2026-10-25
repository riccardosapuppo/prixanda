// Storybook for the console's components, with the Next.js framework on
// Vite. Telemetry is off, here and on the command line (--disable-telemetry):
// nothing leaves the machine.
import type { StorybookConfig } from "@storybook/nextjs-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.tsx"],
  addons: [],
  framework: { name: "@storybook/nextjs-vite", options: {} },
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
};

export default config;
