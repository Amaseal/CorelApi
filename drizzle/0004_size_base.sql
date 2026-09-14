ALTER TABLE "product_sizes" ADD COLUMN IF NOT EXISTS "is_base" boolean DEFAULT false NOT NULL;
