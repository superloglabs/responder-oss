import { trackRedditSignupPixel } from "./reddit-pixel";
import { trackXSignupPixel } from "./x-pixel";

// Marketing callbacks must not interrupt authentication or account routing.
export function trackSignupConversion(userId: string): void {
  for (const track of [trackRedditSignupPixel, trackXSignupPixel]) {
    try {
      track(userId);
    } catch {
      console.error(JSON.stringify({ event: "signup_pixel_failed" }));
    }
  }
}
