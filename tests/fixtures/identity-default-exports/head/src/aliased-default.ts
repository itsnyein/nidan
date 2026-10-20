function toSlug(value: string): string {
  return value.toLowerCase().replaceAll(" ", "-");
}

export default toSlug;
