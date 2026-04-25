# Epic 1: User Profile MVP

## Story 1-1: Data model

Establish the `User` table and the `src/models/user.ts` module that subsequent
stories build on.

**Acceptance Criteria**
1. `src/models/user.ts` exists and exports a `User` type.
2. Database migration creates the `users` table with id, email, name, bio.
3. Tests for the data layer pass.

## Story 1-2: User profile page

Render the user profile from the data model created in 1-1.

**Acceptance Criteria**
1. `src/routes/user.ts` mounts at `/users/:id`.
2. Page reads from the `User` table created in 1-1.
3. Both stories edit `src/models/user.ts` for the read accessor.

## Story 1-3: Avatar upload

Extend the user-profile route from 1-2 with image upload.

**Acceptance Criteria**
1. POST handler at `src/routes/user.ts` accepts multipart upload.
2. Builds on the route mounted in 1-2.

## Story 1-4: Bio edit

Add inline bio editing to the user-profile component from 1-2.

**Acceptance Criteria**
1. Edit button on profile page (component from 1-2).
2. PUT handler updates the `bio` column from the schema in 1-1.
