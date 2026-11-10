import { createApp } from './api.mjs';
import { createStore } from './store.mjs';

export default {
  fetch(request, env) {
    const store = createStore({
      async all(sql, ...values) {
        return (await env.DB.prepare(sql).bind(...values).all()).results;
      },
      async run(sql, ...values) {
        return (await env.DB.prepare(sql).bind(...values).run()).meta.changes;
      }
    });
    return createApp({ store, secret: env.PLANNER_PASSWORD, assets: req => env.ASSETS.fetch(req) })(request);
  }
};
