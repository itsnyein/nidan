import { slugify } from "@/lib/slug.js";

export function titleFor(value) {
  return slugify(value);
}
