/**
 * English demo data of the mock backend (browser `pnpm dev` in English, README screenshots).
 * Neutral on purpose: no real client, person or company. Same shape as the French set in
 * mock-seed.ts, which the tests (pinned to French) keep using.
 */

import type { SeedSubject, SeedTask } from "./mock-seed";

export const SUBJECTS_EN: SeedSubject[] = [
  {
    name: "Orbit App",
    color: "violet",
    rootPath: "/Users/jane/app",
    sections: [
      ["Backend", "backend"],
      ["Frontend", "frontend"],
    ],
    tasks: [
      {
        title: "Weekly sync with the design team",
        description: "Go over the open design questions and plan the week.",
        dueIn: 0,
        dueTime: "14:00",
        priority: 3,
        subtasks: [
          ["Collect the open questions", false],
          ["List the blocking points", false],
        ],
        createdDaysAgo: 6,
      },
      {
        title: "Speed up the data import job",
        description: "Make the import faster without changing its output.",
        section: "Backend",
        dueIn: 0,
        priority: 4,
        subtasks: [
          ["Find the bottleneck", true],
          ["Cache the lookup table", false],
          ["Write the index migration", false, 2],
          ["Review with the team", false],
        ],
        createdDaysAgo: 3,
        notes: [
          [
            "The lookup on the accounts table is reloaded for every row. Idea: cache it.",
            26,
          ],
        ],
      },
      {
        title: "Fix the flaky login test",
        description: "It fails about one run in ten on CI.",
        section: "Frontend",
        column: 2,
        dueIn: 0,
        subtasks: [
          ["Reproduce locally", false],
          ["Find the race condition", false],
        ],
        createdDaysAgo: 10,
      },
      {
        title: "Set up the staging environment",
        description: "Same config as production, with sample data.",
        section: "Backend",
        dueIn: 3,
        createdDaysAgo: 2,
      },
      {
        title: "Upgrade to Node 22",
        section: "Frontend",
        completedHoursAgo: 30,
        createdDaysAgo: 8,
      },
    ],
  },
  {
    name: "Clients",
    color: "blue",
    rootPath: null,
    group: true,
    sections: [],
    tasks: [],
  },
  {
    name: "Northwind",
    color: "teal",
    rootPath: "/Users/jane/clients/northwind",
    parent: "Clients",
    sections: [["Dashboards", "dashboards"]],
    tasks: [
      {
        title: "Monthly report: date range filter",
        description: "Add a date range filter to the sales dashboard.",
        section: "Dashboards",
        dueIn: -1,
        priority: 2,
        subtasks: [
          ["Calculated field", true],
          ["Range parameter", true],
          ["Publish", false],
        ],
        createdDaysAgo: 4,
      },
      {
        title: "Landing page mockup",
        description: "Propose a mockup for the new overview page.",
        section: "Dashboards",
        dueIn: 5,
        subtasks: [
          ["Collect the requirements", true],
          ["Sketch the layout", false],
        ],
        createdDaysAgo: 2,
      },
    ],
  },
  {
    name: "Globex",
    color: "pink",
    rootPath: "/Users/jane/globex",
    sections: [
      ["Events", "events"],
      ["Sales", null],
    ],
    tasks: [
      {
        title: "Events: export attendees to CSV",
        description: "Export the attendee list as CSV, filterable by date.",
        section: "Events",
        dueIn: 0,
        dueTime: "17:00",
        subtasks: [
          ["CSV export endpoint", true],
          ["Date filter", false],
          ["Button in the list", false],
        ],
        createdDaysAgo: 1,
      },
      {
        title: "SaaS starter: auth module",
        description: "Magic link, or just email and password?",
        dueIn: 1,
        priority: 2,
        subtasks: [
          ["Compare the options", true],
          ["Prototype", false],
          ["Tests", false],
        ],
        createdDaysAgo: 5,
      },
      {
        title: "Follow up with this week's leads",
        description: "Read the replies and send the follow-ups.",
        section: "Sales",
        dueIn: 0,
        completedHoursAgo: 1,
        createdDaysAgo: 7,
      },
      {
        title: "Prepare the Fabrikam quote",
        section: "Sales",
        dueIn: 10,
        createdDaysAgo: 2,
      },
    ],
  },
  {
    name: "Fabrikam",
    color: "indigo",
    rootPath: "/Users/jane/clients/fabrikam",
    parent: "Clients",
    sections: [],
    tasks: [
      {
        title: "Mockup of the supplier page",
        description: "Follow the client's brand guide.",
        priority: 2,
        createdDaysAgo: 3,
      },
      { title: "Test the review import", createdDaysAgo: 1 },
    ],
  },
  {
    name: "Personal",
    color: "gray",
    rootPath: null,
    sections: [],
    tasks: [
      {
        title: "Side project: landing page",
        description: "Home page and waiting list.",
        dueIn: -2,
        subtasks: [
          ["Page copy", false],
          ["Waiting list form", false],
        ],
        createdDaysAgo: 9,
      },
      {
        title: "Renew passport",
        createdDaysAgo: 12,
      },
    ],
  },
];

export const INBOX_EN: SeedTask[] = [
  { title: "Try Raycast for snippets", createdDaysAgo: 1 },
  {
    title: "Read the article about git worktrees",
    description: "Keep the useful links in the notes.",
    createdDaysAgo: 0,
  },
];
