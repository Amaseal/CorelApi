ALTER TABLE "size_library" DROP CONSTRAINT "size_library_product_id_size_label_part_name_unique";--> statement-breakpoint
ALTER TABLE "size_library" DROP COLUMN IF EXISTS "part_name";--> statement-breakpoint
ALTER TABLE "size_library" ADD CONSTRAINT "size_library_product_id_size_label_unique" UNIQUE("product_id","size_label");