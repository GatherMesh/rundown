import { defineRouter } from '#q-app/wrappers';
import { createRouter, createWebHistory } from 'vue-router';
export default defineRouter(() =>
  createRouter({
    history: createWebHistory(),
    routes: [
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
