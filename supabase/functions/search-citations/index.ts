import "https://deno.land/x/xhr@0.3.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { query, userId } = await req.json();
    
    if (!query) {
      throw new Error("Query is required");
    }

    console.log("Searching for:", query);

    // Step 1: Use AI to expand the query for better academic search
    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    const expandedQuery = await expandQuery(query, ANTHROPIC_API_KEY);
    console.log("Expanded query:", expandedQuery);

    // Step 2: Search using Tavily for web results and academic databases
    const [tavilyResults, semanticResults, crossrefResults] = await Promise.allSettled([
      searchTavily(expandedQuery),
      searchSemanticScholar(expandedQuery),
      searchCrossRef(expandedQuery),
    ]);

    // Combine and deduplicate results
    const allResults: any[] = [];
    
    if (tavilyResults.status === "fulfilled") {
      allResults.push(...tavilyResults.value);
    }
    
    if (semanticResults.status === "fulfilled") {
      allResults.push(...semanticResults.value);
    }
    
    if (crossrefResults.status === "fulfilled") {
      allResults.push(...crossrefResults.value);
    }

    // Step 3: Deduplicate by DOI or title similarity
    const uniqueResults = deduplicateResults(allResults);
    
    // Step 4: Rank results (basic scoring)
    const rankedResults = rankResults(uniqueResults, query);

    // Step 5: Store search history
    if (userId) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabase = createClient(supabaseUrl, supabaseKey);

      await supabase.from("search_history").insert({
        user_id: userId,
        query,
        expanded_query: expandedQuery,
        results: rankedResults.slice(0, 10),
      });
    }

    return new Response(
      JSON.stringify({
        query,
        expandedQuery,
        results: rankedResults.slice(0, 10),
        totalFound: rankedResults.length,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error in search-citations:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

async function expandQuery(query: string, apiKey: string | undefined): Promise<string> {
  if (!apiKey) {
    return query; // Fallback to original query
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: `You are an academic research assistant. Expand this statement into a precise academic search query. Extract key concepts, add relevant synonyms, and identify the main research topic. Return ONLY the expanded search query, no explanation.

Statement: "${query}"`,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error("AI query expansion failed:", response.status);
      return query;
    }

    const data = await response.json();
    return data.content[0]?.text?.trim() || query;
  } catch (error) {
    console.error("Error expanding query:", error);
    return query;
  }
}

async function searchTavily(query: string): Promise<any[]> {
  const TAVILY_API_KEY = Deno.env.get("TAVILY_API_KEY");
  
  if (!TAVILY_API_KEY) {
    console.log("Tavily API key not found, skipping Tavily search");
    return [];
  }

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: query,
        search_depth: "advanced",
        include_answer: false,
        include_raw_content: false,
        max_results: 5,
      }),
    });

    if (!response.ok) {
      console.error("Tavily API error:", response.status);
      return [];
    }

    const data = await response.json();
    return (data.results || []).map((result: any) => ({
      title: result.title || "Untitled",
      authors: "Web Source",
      year: new Date().getFullYear(),
      abstract: result.content || "No content available",
      url: result.url,
      source: "Tavily Web Search",
      citationCount: 0,
      doi: null,
    }));
  } catch (error) {
    console.error("Tavily search error:", error);
    return [];
  }
}

async function searchSemanticScholar(query: string): Promise<any[]> {
  try {
    const encodedQuery = encodeURIComponent(query);
    const response = await fetch(
      `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodedQuery}&limit=10&fields=title,authors,year,abstract,url,citationCount,publicationDate,externalIds`
    );

    if (!response.ok) {
      console.error("Semantic Scholar API error:", response.status);
      return [];
    }

    const data = await response.json();
    return (data.data || []).map((paper: any) => ({
      title: paper.title,
      authors: paper.authors?.map((a: any) => a.name).join(", ") || "Unknown",
      year: paper.year || new Date(paper.publicationDate).getFullYear(),
      abstract: paper.abstract || "No abstract available",
      url: paper.url,
      source: "Semantic Scholar",
      citationCount: paper.citationCount || 0,
      doi: paper.externalIds?.DOI,
    }));
  } catch (error) {
    console.error("Semantic Scholar search error:", error);
    return [];
  }
}

async function searchCrossRef(query: string): Promise<any[]> {
  try {
    const encodedQuery = encodeURIComponent(query);
    const response = await fetch(
      `https://api.crossref.org/works?query=${encodedQuery}&rows=10`
    );

    if (!response.ok) {
      console.error("CrossRef API error:", response.status);
      return [];
    }

    const data = await response.json();
    return (data.message?.items || []).map((item: any) => ({
      title: item.title?.[0] || "Untitled",
      authors: item.author?.map((a: any) => `${a.given} ${a.family}`).join(", ") || "Unknown",
      year: item.published?.["date-parts"]?.[0]?.[0] || null,
      abstract: item.abstract || "No abstract available",
      url: item.URL,
      source: "CrossRef",
      citationCount: item["is-referenced-by-count"] || 0,
      doi: item.DOI,
    }));
  } catch (error) {
    console.error("CrossRef search error:", error);
    return [];
  }
}

function deduplicateResults(results: any[]): any[] {
  const seen = new Set<string>();
  const unique: any[] = [];

  for (const result of results) {
    const key = result.doi || result.title.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(result);
    }
  }

  return unique;
}

function rankResults(results: any[], originalQuery: string): any[] {
  const queryLower = originalQuery.toLowerCase();
  
  return results
    .map((result) => {
      let score = 0;
      
      // Title relevance
      if (result.title.toLowerCase().includes(queryLower)) {
        score += 10;
      }
      
      // Abstract relevance
      if (result.abstract.toLowerCase().includes(queryLower)) {
        score += 5;
      }
      
      // Citation count (logarithmic scale)
      score += Math.log(result.citationCount + 1);
      
      // Recency bonus (papers from last 5 years)
      const currentYear = new Date().getFullYear();
      if (result.year && currentYear - result.year <= 5) {
        score += 3;
      }
      
      return { ...result, relevanceScore: score };
    })
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
}
