import { assert } from "https://deno.land/std@0.201.0/assert/assert.ts";
import { ExFetch } from "./exfetch.ts";
Deno.test("https://jsonplaceholder.typicode.com/posts", async () => {
	const response = await new ExFetch().fetch("https://jsonplaceholder.typicode.com/posts");
	assert(response.ok === true && response.status === 200);
});
