# Railway / Heroku-style process definitions.
# Deploy the worker and the admin dashboard as SEPARATE services, each with the
# same environment variables. The worker is the always-on execution process;
# the admin service serves the secure dashboard + control API.
worker: npm run migrate && npm run worker
admin: npm run migrate && npm run admin
