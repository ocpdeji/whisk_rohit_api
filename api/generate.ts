import type { Credentials, FetchedImage, GenerationResult, ImageMetadata, Images, Projects, Prompt, RefinementRequest, Result } from "./global.types";
import type { Request } from "./global.types";
import { request } from "./utils/request.js";
import { writeFileSync } from "fs";

export default class Whisk {
  credentials: Credentials;

  constructor(credentials: Credentials) {
    if (!credentials.cookie || credentials.cookie == "INVALID_COOKIE") {
      throw new Error("Cookie is missing or invalid.")
    }

    this.credentials = structuredClone(credentials)
  }

  async #checkCredentials() {
    if (!this.credentials.cookie) {
      throw new Error("Credentials are not set. Please provide a valid cookie.");
    }

    if (!this.credentials.authorizationKey) {
      const resp = await this.getAuthorizationToken();

      if (resp.Err || !resp.Ok) {
        throw new Error("Failed to get authorization token: " + resp.Err);
      }

      this.credentials.authorizationKey = resp.Ok;
    }
  }

  /**
   * Check if `Whisk` is available in your region.
   *
   * This un-availability can be easily bypassed by
   * generating authorization token from a region where
   * its available. Use VPN with US regions.
   */
  async isAvailable(): Promise<Result<boolean>> {
    const req: Request = {
      body: "{}",
      method: "POST",
      url: "https://aisandbox-pa.googleapis.com/v1:checkAppAvailability",
      headers: new Headers({ // The API key might not work next-time (unsure)
        "Content-Type": "text/plain;charset=UTF-8",
        "X-Goog-Api-Key": "AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY",
      }),
    };

    const response = await request(req);
    if (response.Err || !response.Ok) {
      return { Err: response.Err };
    }

    try {
      const responseBody = JSON.parse(response.Ok);
      return { Ok: responseBody.availabilityState === "AVAILABLE" };
    } catch (err) {
      return { Err: new Error("Failed to parse response: " + response.Ok) };
    }
  }

  /**
   * Generates the authorization token for the user.
   * This generated token is required to make *most* of API calls.
   */
  async getAuthorizationToken(): Promise<Result<string>> {
    // Not on this one
    // await this.#checkCredentials();
    if (!this.credentials.cookie) {
      return { Err: new Error("Empty or invalid cookies.") }
    }

    const req: Request = {
      method: "GET",
      url: "https://labs.google/fx/api/auth/session",
      headers: new Headers({ "Cookie": String(this.credentials.cookie) }),
    };

    const resp = await request(req);
    if (resp.Err || !resp.Ok) {
      return { Err: resp.Err }
    }

    try {
      const parsedResp = JSON.parse(resp.Ok);
      const token = parsedResp?.access_token;

      if (!token) {
        return { Err: new Error("Failed to get session token: " + resp.Ok) }
      }

      // Let's not mutate the credentials directly
      // this.credentials.authorizationKey = token;
      return { Ok: String(token) };
    } catch (err) {
      return { Err: new Error("Failed to parse response: " + resp.Ok) };
    }
  }

  /**
   * Get the current credit status of the user. This is for `veo` only and not `whisk`.
   */
  async getCreditStatus(): Promise<Result<number>> {
    await this.#checkCredentials();

    const req: Request = {
      method: "POST",
      body: JSON.stringify({ "tool": "BACKBONE", "videoModel": "VEO_2_1_I2V" }), // Unknown of other models
      url: "https://aisandbox-pa.googleapis.com/v1:GetUserVideoCreditStatusAction",
      headers: new Headers({ "Authorization": String(this.credentials.authorizationKey) }),
    };

    const response = await request(req);
    if (response.Err || !response.Ok) {
      return { Err: response.Err };
    }

    try {
      const responseBody = JSON.parse(response.Ok);

      // Other properties don't seem to be useful
      return { Ok: Number(responseBody.credits) }
    } catch (err) {
      return { Err: new Error("Failed to parse response: " + response.Ok) };
    }
  }

  /**
   * Generates a new project ID (a unique identifier for each project) for the
   * given title so that you can start generating images in that specific project.
   * 
   * @param projectTitle The name you want to give to the project.
   */
  async getNewProjectId(projectTitle: string): Promise<Result<string>> {
    await this.#checkCredentials();

    const req: Request = {
      method: "POST",
      // Long ass JSON
      body: JSON.stringify({
        "json": {
          "clientContext": {
            "tool": "BACKBONE",
            "sessionId": ";1748266079775" // Doesn't matter whatever the value is
            // But probably the last login time
          },
          "workflowMetadata": { "workflowName": projectTitle }
        }
      }),
      url: "https://labs.google/fx/api/trpc/media.createOrUpdateWorkflow",
      headers: new Headers({ "Cookie": String(this.credentials.cookie) }),
    };

    const resp = await request(req);
    if (resp.Err || !resp.Ok) {
      return { Err: resp.Err }
    }

    try {
      const parsedResp = JSON.parse(resp.Ok);
      const workflowID = parsedResp?.result?.data?.json?.result?.workflowId;

      return workflowID ? { Ok: String(workflowID) } : { Err: new Error("Failed to create new library" + resp.Ok) };
    } catch (err) {
      return { Err: new Error("Failed to parse response: " + resp.Ok) }
    }
  }

  /**
   * Get all of your project history or library.
   * 
   * @param limitCount The number of projects you want to fetch.
   */
  async getProjectHistory(limitCount: number): Promise<Result<Projects[]>> {
    await this.#checkCredentials();

    const reqJson = {
      "json": {
        "rawQuery": "",
        "type": "BACKBONE",
        "subtype": "PROJECT",
        "limit": limitCount,
        "cursor": null
      },
      "meta": { "values": { "cursor": ["undefined"] } }
    };

    const req: Request = {
      method: "GET",
      headers: new Headers({
        "Content-Type": "application/json",
        "Cookie": String(this.credentials.cookie),
      }),
      url: `https://labs.google/fx/api/trpc/media.fetchUserHistory?input=` + JSON.stringify(reqJson),
    };

    const resp = await request(req);
    if (resp.Err || !resp.Ok) {
      return { Err: resp.Err }
    }

    try {
      const parsedResp = JSON.parse(resp.Ok);
      const workflowList = parsedResp?.result?.data?.json?.result?.userWorkflows;

      // More cases required here
      if (workflowList && Array.isArray(workflowList)) {
        return { Ok: workflowList as Projects[] }
      }

      return { Err: new Error("Failed to get project history: " + resp.Ok) }
    } catch (err) {
      return { Err: new Error("Failed to parse response: " + resp.Ok) };
    }
  }

  /**
   * Get the image history of the user.
   * 
   * @param limitCount The number of images you want to fetch.
   */
  async getImageHistory(limitCount: number): Promise<Result<Images[]>> {
    await this.#checkCredentials();

    // No upper known limit
    if (limitCount <= 0) {
      return { Err: new Error("Limit count must be between 1 and 100.") };
    }

    const reqJson = {
      "json": {
        "rawQuery": "",
        "type": "BACKBONE",
        "subtype": "IMAGE",
        "limit": limitCount,
        "cursor": null
      },
      "meta": { "values": { "cursor": ["undefined"] } }
    };

    const req: Request = {
      method: "GET",
      headers: new Headers({
        "Content-Type": "application/json",
        "Cookie": String(this.credentials.cookie),
      }),
      url: `https://labs.google/fx/api/trpc/media.fetchUserHistory?input=` + JSON.stringify(reqJson),
    };

    const resp = await request(req);
    if (resp.Err || !resp.Ok) return { Err: resp.Err }

    try {
      const parsedResp = JSON.parse(resp.Ok);
      const mediaList = parsedResp?.result?.data?.json?.result?.userWorkflows;

      // More cases required here
      if (mediaList && Array.isArray(mediaList)) {
        return { Ok: mediaList as Images[] }
      }

      return { Err: new Error("Failed to get image history: " + resp.Ok) }
    } catch (err) {
      return { Err: new Error("Failed to parse response: " + resp.Ok) };
    }
  }

  /**
   * Fetches the content of a project by its ID.
   * 
   * @param projectId The ID of the project you want to fetch content from.
   */
  async getProjectContent(projectId: string): Promise<Result<ImageMetadata[]>> {
    await this.#checkCredentials();

    if (!projectId) {
      return { Err: new Error("Project ID is required to fetch project content.") };
    }

    const reqJson = { "json": { "workflowId": projectId } };
    const req: Request = {
      method: "GET",
      headers: new Headers({
        "Content-Type": "application/json",
        "Cookie": String(this.credentials.cookie),
      }),
      url: `https://labs.google/fx/api/trpc/media.getProjectWorkflow?input=` + JSON.stringify(reqJson),
    };

    const resp = await request(req);
    if (resp.Err || !resp.Ok) {
      return { Err: resp.Err }
    }

    try {
      const parsedResp = JSON.parse(resp.Ok);
      const mediaList = parsedResp?.result?.data?.json?.result?.media;

      // More cases required here
      if (!mediaList || !Array.isArray(mediaList)) {
        return { Err: new Error("Failed to get project content: " + resp.Ok) };
      }

      return { Ok: mediaList as ImageMetadata[] };
    } catch (err) {
      return { Err: new Error("Failed to parse response: " + resp.Ok) };
    }
  }


  /**
   * Rename a project title.
   * 
   * @param newName New name for your project
   * @param projectId Identifier for project that you need to rename
   */
  async renameProject(newName: string, projectId: string): Promise<Result<string>> {
    if (!this.credentials.cookie) {
      return { Err: new Error("Cookie field is empty") };
    }

    const reqJson = {
      "json": {
        "workflowId": projectId,
        "clientContext": {
          "sessionId": ";1748333296243",
          "tool": "BACKBONE",
          "workflowId": projectId
        },
        "workflowMetadata": { "workflowName": newName }
      }
    };

    const req: Request = {
      method: "POST",
      body: JSON.stringify(reqJson),
      headers: new Headers({
        "Content-Type": "application/json",
        "Cookie": String(this.credentials.cookie),
      }),
      url: "https://labs.google/fx/api/trpc/media.createOrUpdateWorkflow",
    };

    const resp = await request(req);
    if (resp.Err || !resp.Ok) {
      return { Err: resp.Err };
    }

    try {
      const parsedBody = JSON.parse(resp.Ok);
      const workflowId = parsedBody?.result?.data?.json?.result?.workflowId;

      if (parsedBody.error || !workflowId) {
        return { Err: new Error("Failed to rename project: " + resp.Ok) }
      }

      return { Ok: String(workflowId) }
    } catch (err) {
      return { Err: new Error("Failed to parse JSON: " + resp.Ok) }
    }
  }

  /**
   * Delete project(s) from libary
   * 
   * @param projectIds Array of project id that you need to delete.
  */
  async deleteProjects(projectIds: string[]): Promise<Result<boolean>> {
    if (!this.credentials.cookie) {
      return { Err: new Error("Cookie field is empty") };
    }

    const reqJson = {
      "json":
      {
        "parent": "userProject/",
        "names": projectIds,
      }
    };

    const req: Request = {
      method: "POST",
      body: JSON.stringify(reqJson),
      url: "https://labs.google/fx/api/trpc/media.deleteMedia",
      headers: new Headers({
        "Content-Type": "application/json",
        "Cookie": String(this.credentials.cookie),
      }
      )
    };

    const resp = await request(req);
    if (resp.Err || !resp.Ok) {
      return { Err: resp.Err }
    }

    try {
      const parsedResp = JSON.parse(resp.Ok);

      if (parsedResp.error) {
        return { Err: new Error("Failed to delete media: " + resp.Ok) }
      }

      return { Ok: true };
    } catch (err) {
      return { Err: new Error("Failed to parse JSON: " + resp.Ok) }
    }
  }

  /**
   * Fetches the base64 encoded image from its media key (name).
   * Media key can be obtained by calling: `getImageHistory()[0...N].name`
   * 
   * @param mediaKey The media key of the image you want to fetch.
   */
  async getMedia(mediaKey: string): Promise<Result<FetchedImage>> {
    await this.#checkCredentials();

    if (!mediaKey) {
      return { Err: new Error("Media key is required to fetch the image.") };
    }

    const reqJson = { "json": { "mediaKey": mediaKey } };
    const req: Request = {
      method: "GET",
      headers: new Headers({
        "Content-Type": "application/json",
        "Cookie": String(this.credentials.cookie),
      }),
      url: `https://labs.google/fx/api/trpc/media.fetchMedia?input=` + JSON.stringify(reqJson),
    };

    const resp = await request(req);
    if (resp.Err || !resp.Ok) {
      return { Err: resp.Err }
    }

    try {
      const parsedResp = JSON.parse(resp.Ok);
      const image = parsedResp?.result?.data?.json?.result;

      if (!image) {
        return { Err: new Error("Failed to get media: " + resp.Ok) };
      }

      return { Ok: image as FetchedImage };
    } catch (err) {
      return { Err: new Error("Failed to parse response: " + resp.Ok) };
    }
  }

  /**
   * Generates an image based on the provided prompt.
   * 
   * @param prompt The prompt containing the details for image generation.
   */
  async generateImage(prompt: Prompt): Promise<Result<GenerationResult>> {
    await this.#checkCredentials();

    if (!prompt || !prompt.prompt) {
      return { Err: new Error("Invalid prompt. Please provide a valid prompt and projectId") };
    }

    // You missed the projectId, so let's create a new one
    if (!prompt.projectId) {
      const id = await this.getNewProjectId("New Project");
      if (id.Err || !id.Ok)
        return { Err: id.Err }

      prompt.projectId = id.Ok;
    }

    // Because seed can be zero
    if (prompt.seed == undefined) {
      prompt.seed = 0;
    }

    if (!prompt.imageModel) {
      prompt.imageModel = "IMAGEN_3_5";
    }

    if (!prompt.aspectRatio) {
      prompt.aspectRatio = "IMAGE_ASPECT_RATIO_LANDSCAPE"; // Default in frontend
    }

    const reqJson = {
      "clientContext": {
        "workflowId": prompt.projectId,
        "tool": "BACKBONE",
        "sessionId": ";1748281496093"
      },
      "imageModelSettings": {
        "imageModel": prompt.imageModel,
        "aspectRatio": prompt.aspectRatio,
      },
      "seed": prompt.seed,
      "prompt": prompt.prompt,
      "mediaCategory": "MEDIA_CATEGORY_BOARD"
    };

    const req: Request = {
      method: "POST",
      body: JSON.stringify(reqJson),
      url: "https://aisandbox-pa.googleapis.com/v1/whisk:generateImage",
      headers: new Headers({
        "Content-Type": "application/json",
        "Authorization": `Bearer ${String(this.credentials.authorizationKey)}`, // Requires bearer
      }),
    };

    const resp = await request(req);
    if (resp.Err || !resp.Ok) {
      return { Err: resp.Err }
    }

    try {
      const parsedResp = JSON.parse(resp.Ok);
      if (parsedResp.error) {
        return { Err: new Error("Failed to generate image: " + resp.Ok) }
      }

      return { Ok: parsedResp as GenerationResult }
    } catch (err) {
      return { Err: new Error("Failed to parse response:" + resp.Ok) }
    }
  }

  /**
   * Refine a generated image.
   * 
   * Refination actually happens in the followin way:
   * 1. Client provides an image (base64 encoded) to refine with new prompt eg: "xyz".
   * 2. Server responds with *a new prompt describing your image* eg: AI-Mix("pqr", "xyz") 
   *    Where `pqr` - Description of original image
   * 3. Client requests image re-generation as: AI-Mix("pqr", "xyz")
   * 4. Server responds with new base64 encoded image
   */
  async refineImage(ref: RefinementRequest): Promise<Result<GenerationResult>> {
    await this.#checkCredentials();

    if (ref.seed == undefined) {
      ref.seed = 0;
    }

    if (!ref.aspectRatio) {
      ref.aspectRatio = "IMAGE_ASPECT_RATIO_LANDSCAPE"; // Default in frontend
    }

    if (!ref.imageModel) {
      ref.imageModel = "IMAGEN_3_5"; // Default in frontend (This is actually Imagen 4)
    }

    if (!ref.count) {
      ref.count = 1; // Default in frontend
    }

    const reqJson = {
      "json": {
        "existingPrompt": ref.existingPrompt,
        "textInput": ref.newRefinement,
        "editingImage": {
          "imageId": ref.imageId,
          "base64Image": ref.base64image,
          "category": "STORYBOARD",
          "prompt": ref.existingPrompt,
          "mediaKey": ref.imageId,
          "isLoading": false,
          "isFavorite": null,
          "isActive": true,
          "isPreset": false,
          "isSelected": false,
          "index": 0,
          "imageObjectUrl": "blob:https://labs.google/1c612ac4-ecdf-4f77-9898-82ac488ad77f",
          "recipeInput": {
            "mediaInputs": [],
            "userInput": {
              "userInstructions": ref.existingPrompt
            }
          },
          "currentImageAction": "REFINING",
          "seed": ref.seed
        },
        "sessionId": ";1748338835952" // doesn't matter
      },
      "meta": {
        "values": {
          "editingImage.isFavorite": [
            "undefined"
          ]
        }
      }
    };

    const req: Request = {
      method: "POST",
      body: JSON.stringify(reqJson),
      url: "https://labs.google/fx/api/trpc/backbone.generateRewrittenPrompt",
      headers: new Headers({
        "Content-Type": "application/json",
        "Cookie": String(this.credentials.cookie),
      }),
    };

    const resp = await request(req);
    if (resp.Err || !resp.Ok) {
      return { Err: resp.Err }
    }

    let parsedResp;
    try {
      parsedResp = JSON.parse(resp.Ok);
      if (parsedResp.error) {
        return { Err: new Error("Failed to refine image: " + resp.Ok) };
      }
    }
    catch (err) {
      return { Err: new Error("Failed to parse response: " + resp.Ok) };
    }

    const newPrompt = parsedResp?.result?.data?.json;
    if (!newPrompt) {
      return { Err: new Error("Failed to get new prompt from response: " + resp.Ok) };
    }

    const reqJson2 = {
      "userInput": {
        "candidatesCount": ref.count,
        "seed": ref.seed,
        "prompts": [newPrompt],
        "mediaCategory": "MEDIA_CATEGORY_BOARD",
        "recipeInput": {
          "userInput": {
            "userInstructions": newPrompt,
          },
          "mediaInputs": []
        }
      },
      "clientContext": {
        "sessionId": ";1748338835952", // can be anything
        "tool": "BACKBONE",
        "workflowId": ref.projectId,
      },
      "modelInput": {
        "modelNameType": ref.imageModel
      },
      "aspectRatio": ref.aspectRatio
    }

    const req2: Request = {
      method: "POST",
      body: JSON.stringify(reqJson2),
      url: "https://aisandbox-pa.googleapis.com/v1:runBackboneImageGeneration",
      headers: new Headers({
        "Content-Type": "text/plain;charset=UTF-8", // Yes
        "Authorization": `Bearer ${String(this.credentials.authorizationKey)}`, // Requires bearer
      }),
    };

    const resp2 = await request(req2);
    if (resp2.Err || !resp2.Ok) {
      return { Err: resp2.Err }
    }

    try {
      const parsedResp2 = JSON.parse(resp2.Ok);
      if (parsedResp2.error) {
        return { Err: new Error("Failed to refine image: " + resp2.Ok) };
      }

      return { Ok: parsedResp2 as GenerationResult };
    } catch (err) {
      return { Err: new Error("Failed to parse response: " + resp2.Ok) };
    }
  }

  /**
   * Save image to a file with the given name.
   * 
   * @param image The base64 encoded image string.
   * @param fileName The name of the file where the image will be saved.
   */
  saveImage(image: string, fileName: string): Error | null {
    try {
      writeFileSync(fileName, image, { encoding: 'base64' });
      return null;
    } catch (err) {
      return new Error("Failed to save image: " + err);
    }
  }

  /**
   * Save image from its id directly
   * 
   * @param imageId The ID of the image you want to save.
   * @param fileName The name of the file where the image will be saved.
   */
  async saveImageDirect(imageId: string, fileName: string): Promise<Result<boolean>> {
    const image = await this.getMedia(imageId);

    if (image.Err || !image.Ok) {
      return { Err: image.Err };
    }

    try {
      writeFileSync(fileName, image.Ok.image.encodedImage, { encoding: 'base64' });
      return { Ok: true };
    } catch (err) {
      return {
        Err: new Error("Failed to save image: " + err)
      }
    }
  }
}
