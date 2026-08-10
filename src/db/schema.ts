import { pgTable, serial, text, integer, timestamp, boolean, unique } from 'drizzle-orm/pg-core';

export const products = pgTable('products', {
  id:        serial('id').primaryKey(),
  name:      text('name').notNull().unique(),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const productParts = pgTable('product_parts', {
  id:        serial('id').primaryKey(),
  productId: integer('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  partName:  text('part_name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isBase:    boolean('is_base').notNull().default(false),
}, (t) => [unique().on(t.productId, t.partName)]);

export const productSizes = pgTable('product_sizes', {
  id:        serial('id').primaryKey(),
  productId: integer('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  sizeLabel: text('size_label').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => [unique().on(t.productId, t.sizeLabel)]);

export const appSettings = pgTable('app_settings', {
  key:   text('key').primaryKey(),
  value: text('value').notNull().default(''),
});

export const sizeLibrary = pgTable('size_library', {
  id:         serial('id').primaryKey(),
  productId:  integer('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  sizeLabel:  text('size_label').notNull(),
  svgContent: text('svg_content').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique().on(t.productId, t.sizeLabel)]);
