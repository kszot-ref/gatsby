// just types - those should not be bundled
import type { GraphQLEngine } from "../../schema/graphql-engine/entry"
import type { IExecutionResult } from "../../query/types"
import type { IGatsbyPage } from "../../redux/types"
import type { IScriptsAndStyles } from "../client-assets-for-template"
import type { IPageDataWithQueryResult } from "../page-data"
import type { Request } from "express"

// actual imports
import "../engines-fs-provider"
import * as path from "path"
import * as fs from "fs-extra"
import {
  constructPageDataString,
  getPagePathFromPageDataPath,
} from "../page-data-helpers"
// @ts-ignore render-page import will become valid later on (it's marked as external)
import htmlComponentRenderer, { getPageChunk } from "./routes/render-page"
import { getServerData, IServerData } from "../get-server-data"

export interface ITemplateDetails {
  query: string
  staticQueryHashes: Array<string>
  assets: IScriptsAndStyles
}
export interface ISSRData {
  results: IExecutionResult
  page: IGatsbyPage
  templateDetails: ITemplateDetails
  potentialPagePath: string
  serverDataHeaders?: Record<string, string>
  searchString: string
}

const pageTemplateDetailsMap: Record<
  string,
  ITemplateDetails
  // @ts-ignore INLINED_TEMPLATE_TO_DETAILS is being "inlined" by bundler
> = INLINED_TEMPLATE_TO_DETAILS

export async function getData({
  pathName,
  graphqlEngine,
  req,
}: {
  graphqlEngine: GraphQLEngine
  pathName: string
  req?: Partial<Pick<Request, "query" | "method" | "url" | "headers">>
}): Promise<ISSRData> {
  const potentialPagePath = getPagePathFromPageDataPath(pathName) || pathName

  // 1. Find a page for pathname
  const page = graphqlEngine.findPageByPath(potentialPagePath)

  if (!page) {
    // page not found, nothing to run query for
    throw new Error(`Page for "${pathName}" not found`)
  }

  // 2. Lookup query used for a page (template)
  const templateDetails = pageTemplateDetailsMap[page.componentChunkName]
  if (!templateDetails) {
    throw new Error(
      `Page template details for "${page.componentChunkName}" not found`
    )
  }

  const executionPromises: Array<Promise<any>> = []

  // 3. Execute query
  // query-runner handles case when query is not there - so maybe we should consider using that somehow
  let results: IExecutionResult = {}
  let serverData: IServerData | undefined
  if (templateDetails.query) {
    executionPromises.push(
      graphqlEngine
        .runQuery(templateDetails.query, {
          ...page,
          ...page.context,
        })
        .then(queryResults => {
          results = queryResults
        })
    )
  }

  // 4. (if SSR) run getServerData
  if (page.mode === `SSR`) {
    executionPromises.push(
      getPageChunk(page)
        .then(mod => getServerData(req, page, potentialPagePath, mod))
        .then(serverDataResults => {
          serverData = serverDataResults
        })
    )
  }

  await Promise.all(executionPromises)

  if (serverData) {
    results.serverData = serverData.props
  }
  results.pageContext = page.context

  let searchString = ``
  if (req?.query) {
    const maybeQueryString = Object.entries(req.query)
      .map(([k, v]) => `${k}=${v}`)
      .join(`&`)
    if (maybeQueryString) {
      searchString = `?${maybeQueryString}`
    }
  }

  return {
    results,
    page,
    templateDetails,
    potentialPagePath,
    serverDataHeaders: serverData?.headers,
    searchString,
  }
}

function getPath(data: ISSRData): string {
  return (
    (data.page.mode !== `SSG` && data.page.matchPath
      ? data.potentialPagePath
      : data.page.path) + (data.page.mode === `SSR` ? data.searchString : ``)
  )
}

export async function renderPageData({
  data,
}: {
  data: ISSRData
}): Promise<IPageDataWithQueryResult> {
  const results = await constructPageDataString(
    {
      componentChunkName: data.page.componentChunkName,
      path: getPath(data),
      matchPath: data.page.matchPath,
      staticQueryHashes: data.templateDetails.staticQueryHashes,
    },
    JSON.stringify(data.results)
  )

  return JSON.parse(results)
}

const readStaticQueryContext = async (
  templatePath: string
): Promise<Record<string, { data: unknown }>> => {
  const filePath = path.join(
    __dirname,
    `sq-context`,
    templatePath,
    `sq-context.json`
  )
  const rawSQContext = await fs.readFile(filePath, `utf-8`)

  return JSON.parse(rawSQContext)
}

export async function renderHTML({
  data,
  pageData,
}: {
  data: ISSRData
  pageData?: IPageDataWithQueryResult
}): Promise<string> {
  if (!pageData) {
    pageData = await renderPageData({ data })
  }

  const staticQueryContext = await readStaticQueryContext(
    data.page.componentChunkName
  )

  const results = await htmlComponentRenderer({
    pagePath: getPath(data),
    pageData,
    staticQueryContext,
    ...data.templateDetails.assets,
    inlinePageData: data.page.mode === `SSR` && data.results.serverData,
  })

  return results.html
}
