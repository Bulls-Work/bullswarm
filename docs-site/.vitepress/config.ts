import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Bullswarm',
  description:
    'Route bounded coding work across whichever installed agent CLI has quota to spare, and verify the result by its content.',
  srcDir: 'docs',
  base: '/bullswarm/',
  cleanUrls: true,
  ignoreDeadLinks: false,
  // Internal design records contain historical machine-local evidence links;
  // they are source material, not published documentation.
  srcExclude: ['**/node_modules/**', '**/design/**'],
  vite: {
    resolve: {
      preserveSymlinks: true,
    },
  },
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/bullswarm/favicon.png' }],
  ],
  themeConfig: {
    logo: '/brand/bullswarm-mark.png',
    nav: [
      { text: 'Guide', link: '/guide/' },
      { text: 'Reference', link: '/reference/cli' },
      { text: 'Integrations', link: '/integrations/claude-code' },
      { text: 'Notes', link: '/notes/' },
    ],
    sidebar: {
      '/guide/': [
        { text: 'Introduction', link: '/guide/' },
        { text: 'Getting started', link: '/guide/getting-started' },
        { text: 'Day-to-day playbook', link: '/guide/playbook' },
        { text: 'Concepts', link: '/guide/concepts' },
        { text: 'Run one task', link: '/guide/run' },
        { text: 'Workflows', link: '/guide/workflows' },
        { text: 'Observing runs', link: '/guide/observing' },
        { text: 'Dashboard gallery', link: '/guide/gallery' },
        { text: 'Routing', link: '/guide/routing' },
      ],
      '/reference/': [
        { text: 'CLI', link: '/reference/cli' },
        { text: 'Workflow program', link: '/reference/program' },
        { text: 'Configuration', link: '/reference/configuration' },
        { text: 'Providers', link: '/reference/providers' },
        { text: 'Result envelope', link: '/reference/result' },
      ],
      '/integrations/': [
        { text: 'Claude Code', link: '/integrations/claude-code' },
        { text: 'Codex and Grok', link: '/integrations/agent-clis' },
        { text: 'Issue watcher', link: '/integrations/issue-watcher' },
      ],
      '/notes/': [{ text: 'Historical notes', link: '/notes/' }],
    },
    outline: { level: [2, 3] },
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/Bulls-Work/bullswarm' },
    ],
    editLink: {
      pattern: 'https://github.com/Bulls-Work/bullswarm/edit/main/docs/:path',
    },
    footer: { message: 'Released under the MIT License.' },
  },
})
