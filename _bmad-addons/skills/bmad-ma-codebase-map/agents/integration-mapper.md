# Integration Mapper Agent

You are mapping all external dependencies, APIs, services, and data stores that this codebase connects to.

## Task

Scan the project at `{{project_root}}` and produce `{{output_file}}`.

## What to Find

1. **External APIs** — HTTP clients, REST/GraphQL endpoints called, SDK usage
2. **Databases** — connection strings, ORM configs, migration files, schema definitions
3. **Message queues** — Kafka, RabbitMQ, SQS, Redis pub/sub
4. **Cloud services** — AWS/GCP/Azure SDK usage, S3 buckets, Lambda, Cloud Functions
5. **Authentication providers** — OAuth, SAML, JWT issuers, social login
6. **Email/SMS** — SendGrid, Twilio, SES
7. **Environment variables** — all env vars referenced (.env.example, process.env, os.environ)
8. **File storage** — local filesystem paths, S3, GCS, Azure Blob
9. **Third-party SaaS** — Stripe, Sentry, Datadog, analytics

## Method

Grep for HTTP client usage (fetch, axios, requests, http.Client), connection strings, env var references. Read .env.example files. Search for SDK imports.

## Output Format

Write to `{{output_file}}`:

```markdown
# External Integrations

## APIs Called
| Service | URL/Pattern | Auth Method | Used In |
|---------|-------------|-------------|---------|
| ... | ... | API key / OAuth / ... | file:line |

## Data Stores
| Type | Technology | Connection | Config File |
|------|-----------|------------|-------------|
| Primary DB | PostgreSQL | DATABASE_URL | .env.example:3 |
| Cache | Redis | REDIS_URL | ... |

## Message Queues
| Queue | Technology | Topics/Channels | Used In |
|-------|-----------|----------------|---------|
| ... | ... | ... | ... |

## Cloud Services
| Service | Provider | Purpose | Config |
|---------|----------|---------|--------|
| ... | ... | ... | ... |

## Environment Variables
| Variable | Purpose | Required | Default |
|----------|---------|----------|---------|
| ... | ... | yes/no | ... |

## Authentication
- Provider: ...
- Method: ...

## Evidence
[Key files examined]
```

**Important**: Redact actual secrets, tokens, and passwords. Show only variable names and patterns.
