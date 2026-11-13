import { z } from 'zod';
import mongoose from 'mongoose';
import { badRequest } from '../lib/errors.js';
import { isValidTimezone } from '../lib/timezone.js';

/** validate({ body, query, params }) — replaces req.* with the parsed (cleaned) values. */
export const validate = (schemas) => (req, _res, next) => {
  for (const part of ['params', 'query', 'body']) {
    if (!schemas[part]) continue;
    const result = schemas[part].safeParse(req[part] ?? {});
    if (!result.success) {
      return next(
        badRequest(
          'VALIDATION_ERROR',
          'Invalid input',
          result.error.issues.map((i) => ({ path: [part, ...i.path].join('.'), message: i.message }))
        )
      );
    }
    // Express 5 makes req.query a getter, so store parsed values separately for query.
    if (part === 'query') req.validQuery = result.data;
    else req[part] = result.data;
  }
  next();
};

/* ------------------------------ shared pieces ----------------------------- */

export const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id');

const skill = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(30)
  .regex(/^[a-z0-9+#.\- ]+$/, 'Skills may contain letters, numbers, + # . - and spaces');

export const skills = z
  .array(skill)
  .max(15)
  .transform((arr) => [...new Set(arr)]);

export const timezone = z.string().max(64).refine(isValidTimezone, 'Unknown IANA timezone, e.g. "Asia/Kolkata"');

export const schemas = {
  register: z.object({
    name: z.string().trim().min(2).max(60),
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(8).max(128),
    skills: skills.default([]),
    timezone: timezone.default('UTC'),
    bio: z.string().trim().max(280).default(''),
  }),
  login: z.object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1).max(128),
  }),
  updateProfile: z
    .object({
      name: z.string().trim().min(2).max(60).optional(),
      skills: skills.optional(),
      timezone: timezone.optional(),
      bio: z.string().trim().max(280).optional(),
    })
    .strict(),
  createTeam: z
    .object({
      name: z.string().trim().min(2).max(50),
      description: z.string().trim().max(500).default(''),
      skillsWanted: skills.default([]),
    })
    .strict(),
  updateTeam: z
    .object({
      name: z.string().trim().min(2).max(50).optional(),
      description: z.string().trim().max(500).optional(),
      skillsWanted: skills.optional(),
      lookingForMembers: z.boolean().optional(),
    })
    .strict()
    .refine((o) => Object.keys(o).length > 0, 'Nothing to update'),
  redeemInvite: z.object({
    code: z
      .string()
      .trim()
      .min(10)
      .max(16)
      .regex(/^[0-9A-Za-z\- ]+$/, 'Invalid code format'),
  }),
  joinRequest: z.object({ message: z.string().trim().max(300).default('') }).strict(),
  transferLeader: z.object({ userId: objectId }).strict(),
  lookingForTeam: z.object({ lookingForTeam: z.boolean() }).strict(),
  boardQuery: z.object({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    skill: skill.optional(),
  }),
  hackathonParams: z.object({ hackathonId: objectId }),
  teamParams: z.object({ teamId: objectId }),
  memberParams: z.object({ teamId: objectId, userId: objectId }),
  requestParams: z.object({ requestId: objectId }),
};
