# Coexistence Patterns

## Proxy-Based Routing

Route requests between old and new systems via a proxy (nginx, API gateway, feature flag service).

```
Client → Proxy → [route A] → New System
                → [route B] → Old System
```

**Use when**: Strangler fig strategy with HTTP-based services.

## Feature Flags

Toggle between old and new implementations at runtime using feature flags.

```
if feature_enabled("new_auth"):
    return new_auth_handler(request)
else:
    return old_auth_handler(request)
```

**Use when**: Branch-by-abstraction, need gradual rollout with instant rollback.

## Adapter / Anti-Corruption Layer

Wrap old interfaces with adapters that translate to new interfaces.

```
NewService → Adapter → OldService
```

**Use when**: New code needs to call old code (or vice versa) with different contracts.

## Dual-Write

Write to both old and new data stores simultaneously during migration.

```
write(old_db, data)
write(new_db, transform(data))
```

**Use when**: Database migration where both systems need current data.
**Caution**: Must handle write failures to either store.

## Shadow Traffic / Dark Launch

Send production traffic to new system without serving responses. Compare outputs.

```
response = old_system.handle(request)
async: new_system.handle(request)  # compare, don't serve
return response
```

**Use when**: Parallel run strategy, validating before cutover.
