import { defineRouter } from '#q-app/wrappers';
import { createRouter, createWebHistory } from 'vue-router';
export default defineRouter(() =>
  createRouter({
    history: createWebHistory(),
    routes: [{ path: '/:page?', component: () => import('../pages/WorkspacePage.vue') }],
  }),
);
