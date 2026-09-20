import { createBrowserRouter, type RouteObject } from "react-router";
import { RequireAuth } from "@/features/auth";
import { AuthCallbackPage } from "@/pages/auth-callback";
import { NotFoundPage } from "@/pages/not-found";
import { RequestDetailsPage } from "@/pages/request-details";
import { RequestNewPage } from "@/pages/request-new";
import { RequestsListPage } from "@/pages/requests-list";
import { SignInPage } from "@/pages/sign-in";
import { AppLayout } from "./layouts/AppLayout";

// Exported separately from the router so tests can run the same routes in a memory router.
export const routes: RouteObject[] = [
  {
    element: <AppLayout />,
    children: [
      // Outside the guard: the visitor is not signed in yet while this page finishes the sign-in.
      { path: "/auth/callback", element: <AuthCallbackPage /> },
      {
        // Guard as a layout route: everything below needs a signed-in user. Anyone else
        // sees the sign-in page at the same URL.
        element: <RequireAuth fallback={<SignInPage />} />,
        children: [
          { path: "/", element: <RequestsListPage /> },
          { path: "/requests/new", element: <RequestNewPage /> },
          { path: "/requests/:id", element: <RequestDetailsPage /> },
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
];

export const createAppRouter = () => createBrowserRouter(routes);
