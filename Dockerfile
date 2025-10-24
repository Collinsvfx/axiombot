# Use an official Node.js image as the base
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to leverage Docker caching
# This step installs dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the port your application will listen on
# Koyeb will automatically map this internal port to the public service
ENV PORT 3000
EXPOSE 3000

# Define the command to run the application
# This is equivalent to your Procfile command: web: node axiombot.js
CMD [ "node", "axiombot.js" ]
