import { dashboardClient } from './dashboard/client.js';
import { dashboardMessages } from './dashboard/locales.js';
import { dashboardShell } from './dashboard/shell.js';
import { dashboardStyles } from './dashboard/styles.js';

/** All assets are bundled into the CLI; no CDN, framework, or build-time asset copying. */
export function getDashboardHtml(_port: number): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TeamAI Dashboard</title><style>${dashboardStyles}</style></head>
<body>${dashboardShell}
<script>window.dashboardMessages=${JSON.stringify(dashboardMessages).replace(/</g, '\\u003c')};</script>
<script>${dashboardClient}</script></body></html>`;
}
