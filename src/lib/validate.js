import { z } from 'zod';

// Wrap a zod schema as Express middleware validating req.body.
export const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
  }
  req.body = result.data;
  next();
};

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const projectSchema = z.object({
  name: z.string().min(1).max(120),
  key: z.string().min(1).max(20).regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'Key must start with a letter').optional(),
  description: z.string().max(2000).optional(),
  orgId: z.string().optional(),
});

export const orgSchema = z.object({
  name: z.string().min(1).max(120),
});
