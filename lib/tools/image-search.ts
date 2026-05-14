import { tool } from "ai";
import { z } from "zod";

/**
 * Image search tool that returns a product image URL based on a keyword.
 * Uses LoremFlickr for high-quality, relevant product images in this demo.
 */
export const imageSearch = tool({
  description: "Search for a high-quality product image URL based on a product name or keyword.",
  inputSchema: z.object({
    query: z.string().describe("The product name or keyword to search for an image (e.g., 'MacBook Pro 16 silver')"),
  }),
  execute: async ({ query }) => {
    try {
      // In a production environment, this would call a real Image Search API (like Google Custom Search).
      // For this high-fidelity prototype, we use a service that returns relevant images by keyword.
      const keyword = encodeURIComponent(query.replace(/\s+/g, ","));
      const imageUrl = `https://loremflickr.com/800/600/${keyword}`;
      
      return { imageUrl };
    } catch (error) {
      return {
        error: `Image search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});
