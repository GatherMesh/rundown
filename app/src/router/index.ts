import { defineRouter } from '#q-app/wrappers';
import { createRouter, createWebHistory } from 'vue-router';
export default defineRouter(() =>
  createRouter({
    history: createWebHistory(),
    routes: [
      {
        path: '/session/:tenantId/:eventId/:sessionId/:token',
        name: 'public-session-runsheet',
        meta: { public: true },
        component: () => import('../pages/PublicRunsheetPage.vue'),
      },
      {
        path: '/runsheet/:tenantId/:eventId/:personId/:token',
        name: 'public-runsheet',
        meta: { public: true },
        component: () => import('../pages/PublicRunsheetPage.vue'),
      },
      { path: '/:page?', component: () => import('../pages/WorkspacePage.vue') },
    ],
  }),
);
