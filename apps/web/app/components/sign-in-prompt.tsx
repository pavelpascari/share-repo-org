import { Form } from "react-router";

/**
 * For a signed-out visitor on a page that needs sign-in: GitHub sign-in, then back to `returnTo`
 * (the sign-in action remembers it in a short-lived cookie, never in a URL that is logged).
 */
export function SignInPrompt(props: { heading: string; message: string; returnTo: string }) {
  return (
    <>
      <h1 className="text-2xl font-semibold">{props.heading}</h1>
      <p className="mt-2 text-gray-700">{props.message}</p>
      <Form method="post" action="/sign-in" className="mt-6">
        <input type="hidden" name="returnTo" value={props.returnTo} />
        <button type="submit" className="rounded bg-gray-900 px-4 py-2 text-white">
          Sign in with GitHub
        </button>
      </Form>
    </>
  );
}

/** The GitHub account that will receive repository access (threat T7). */
export function GitHubAccount(props: { login: string; avatarUrl: string | null }) {
  return (
    <div className="mt-4 flex items-center gap-3 rounded border border-gray-200 p-3">
      {props.avatarUrl !== null && (
        <img src={props.avatarUrl} alt="" width={40} height={40} className="rounded-full" />
      )}
      <p>
        Access goes to the GitHub account <strong>@{props.login}</strong>.
      </p>
    </div>
  );
}
