# Architecture — User Profile MVP

## Modules

- `src/models/user.ts` — owned by story 1-1; consumed by 1-2, 1-3, 1-4.
- `src/routes/user.ts` — created in 1-2; extended by 1-3 and 1-4.
- `src/components/profile.tsx` — created in 1-2; reused by 1-4.

## Layering

```
1-1 data model
   ↓
1-2 user profile page (route + component)
   ↓        ↓
1-3 avatar 1-4 bio edit
```
